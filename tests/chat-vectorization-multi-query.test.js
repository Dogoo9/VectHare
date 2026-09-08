import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../backends/backend-manager.js', () => ({ isBackendAvailable: vi.fn(() => true) }));

const { queryMultipleCollections } = vi.hoisted(() => ({ queryMultipleCollections: vi.fn() }));

vi.mock('../core/../../../../../script.js', () => ({
    getCurrentChatId: vi.fn(() => 'chat-1'), is_send_press: false, setExtensionPrompt: vi.fn(),
    substituteParams: value => value, chat_metadata: {}, extension_prompts: {},
    getRequestHeaders: vi.fn(() => ({})),
}));
vi.mock('../core/../../../../extensions.js', () => ({
    extension_settings: {
        vecthare: {
            collections: {
                'vecthare_chat_chat_chat-1': { alwaysActive: true },
            },
        },
    },
    getContext: vi.fn(() => ({})),
}));
vi.mock('../core/../../../../utils.js', () => ({
    getStringHash: value => [...String(value)].reduce((sum, char) => sum + char.charCodeAt(0), 0),
    waitUntilCondition: vi.fn(), onlyUnique: vi.fn(),
}));

vi.mock('../core/core-vector-api.js', () => ({
    getSavedHashes: vi.fn(),
    insertVectorItems: vi.fn(),
    queryMultipleCollections,
    queryActiveCollections: vi.fn(),
    deleteVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
}));

import { extension_settings } from '../core/../../../../extensions.js';
import {
    filterManuallyDisabledChunks,
    promoteKeywordMatches,
    queryAndMergeCollections,
    rearrangeChat,
} from '../core/chat-vectorization.js';

describe('per-entry retrieval state', () => {
    it('keeps only entries enabled in the visualizer or backend metadata', () => {
        const vecthare = extension_settings.vecthare;
        vecthare.vecthare_chunk_meta_2 = { enabled: false };
        vecthare.vecthare_chunk_meta_3 = { disabled: true };

        const filtered = filterManuallyDisabledChunks([
            { hash: 1, metadata: {} },
            { hash: 2, metadata: {} },
            { hash: 3, metadata: {} },
            { hash: 4, metadata: { enabled: false } },
            { hash: 5, metadata: { disabled: true } },
        ]);

        expect(filtered.map(chunk => chunk.hash)).toEqual([1]);
        delete vecthare.vecthare_chunk_meta_2;
        delete vecthare.vecthare_chunk_meta_3;
    });
});

describe('authoritative keyword activation', () => {
    it('promotes an exact keyword hit to a 100% score', () => {
        const chunks = [{ hash: 10, score: 0.08, metadata: { keywords: ['Red Dragon'] } }];

        expect(promoteKeywordMatches(chunks, 'I approach the red dragon carefully')).toBe(1);
        expect(chunks[0]).toMatchObject({
            score: 1,
            originalScore: 0.08,
            keywordMatched: true,
            keywordForceInjected: true,
            matchedQueryKeywords: ['red dragon'],
        });
    });

    it('uses whole boundaries and ignores explicitly disabled keywords', () => {
        const chunks = [
            { hash: 11, score: 0.2, metadata: { keywords: ['mel'] } },
            { hash: 12, score: 0.2, metadata: { keywords: [{ text: 'melody', enabled: false }] } },
        ];

        expect(promoteKeywordMatches(chunks, 'A melody begins')).toBe(0);
        expect(chunks.map(chunk => chunk.score)).toEqual([0.2, 0.2]);
    });
});

describe('queryAndMergeCollections multi-query', () => {
    beforeEach(() => queryMultipleCollections.mockReset());

    it('uses one multi-collection call and retains source collection metadata', async () => {
        queryMultipleCollections.mockResolvedValue({
            first: { hashes: [1], metadata: [{ text: 'one', score: 0.9 }] },
            second: { hashes: [2], metadata: [{ text: 'two', score: 0.8 }] },
        });

        const results = await queryAndMergeCollections(
            ['first', 'second'], 'query', { top_k: 5, score_threshold: 0.2 }, [], { trace: [], chunkFates: {} },
        );

        expect(queryMultipleCollections).toHaveBeenCalledOnce();
        // Backend thresholding is deliberately disabled so low-scoring exact
        // keyword hits survive long enough to be promoted locally.
        expect(queryMultipleCollections).toHaveBeenCalledWith(['first', 'second'], 'query', 500, 0, expect.any(Object));
        expect(results.map(result => result.collectionId)).toEqual(['first', 'second']);
        expect(results.map(result => result.metadata.collectionId)).toEqual(['first', 'second']);
        expect(results.map(result => result.score)).toEqual([0.9, 0.8]);
        expect(results[0].fusedScore).toBeCloseTo(1 / 61);
    });

    it('resolves both candidate budget names without aborting retrieval', async () => {
        queryMultipleCollections.mockResolvedValue({
            collection: { hashes: [99], metadata: [{ text: 'keyword result', score: 0.4 }] },
        });

        await expect(queryAndMergeCollections(
            ['collection'], 'keyword', { top_k: 3, candidate_k: 23, candidate_k_max: 500 }, [],
            { trace: [], chunkFates: {} },
        )).resolves.toHaveLength(1);
        expect(queryMultipleCollections).toHaveBeenCalledWith(
            ['collection'], 'keyword', 500, 0, expect.any(Object),
        );
    });

    it('requests up to 500 Qdrant candidates when configured to pull 500 entries', async () => {
        queryMultipleCollections.mockResolvedValue({ qdrant_collection: { hashes: [], metadata: [] } });

        await queryAndMergeCollections(
            ['qdrant_collection'],
            'query',
            { vector_backend: 'qdrant', top_k: 500, candidate_k_max: 500 },
            [],
            { trace: [], chunkFates: {} },
        );

        expect(queryMultipleCollections).toHaveBeenCalledWith(
            ['qdrant_collection'], 'query', 500, 0, expect.any(Object),
        );
    });

    it('keeps successful collections when another collection fails', async () => {
        queryMultipleCollections.mockResolvedValue({
            good: { hashes: [7], metadata: [{ text: 'kept', score: 0.7 }] },
            bad: { hashes: [], metadata: [], error: 'backend unavailable' },
        });

        const results = await queryAndMergeCollections(
            ['good', 'bad'], 'query', { top_k: 5 }, [], { trace: [], chunkFates: {} },
        );

        expect(results).toHaveLength(1);
        expect(results[0]).toMatchObject({ hash: 7, text: 'kept', collectionId: 'good' });
    });

    it('falls back to chat text while retaining normalized metadata', async () => {
        // The test stub hashes strings by their content; use the corresponding value.
        const chat = [{ mes: 'remember me' }];
        queryMultipleCollections.mockResolvedValue({
            chat: { hashes: [1059], metadata: [{ score: 0.6, messageId: 3 }] },
        });
        const results = await queryAndMergeCollections(
            ['chat'], 'query', { top_k: 5 }, chat, { trace: [], chunkFates: {} },
        );
        expect(results[0]?.metadata.messageId).toBe(3);
        expect(results[0]?.collectionId).toBe('chat');
    });
});

describe('rearrangeChat retrieval timings', () => {
    it('completes without reranking when no candidates are returned', async () => {
        globalThis.toastr = { error: vi.fn() };
        globalThis.window = {};
        queryMultipleCollections.mockReset();
        queryMultipleCollections.mockResolvedValue({});

        await expect(rearrangeChat(
            [{ mes: 'A sufficiently detailed retrieval query' }],
            { enabled_chats: true, query: 1, top_k: 5, score_threshold: 0 },
            'normal',
        )).resolves.toBeUndefined();
        expect(queryMultipleCollections).toHaveBeenCalledOnce();
        expect(globalThis.toastr.error).not.toHaveBeenCalled();
    });
});
