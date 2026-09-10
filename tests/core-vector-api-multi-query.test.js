import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    embedTexts: vi.fn(async () => [[0.1, 0.2]]),
    backendQuery: vi.fn(async ids => Object.fromEntries(ids.map(id => [id, { hashes: [], metadata: [] }]))),
}));

vi.mock('../core/../../../../../script.js', () => ({ getRequestHeaders: () => ({}) }));
vi.mock('../core/../../../../extensions.js', () => ({ extension_settings: {}, modules: [] }));
vi.mock('../core/../../../../secrets.js', () => ({
    secret_state: {},
    SECRET_KEYS: new Proxy({}, { get: (_target, key) => String(key) }),
}));
vi.mock('../core/../../../../textgen-settings.js', () => ({ textgen_types: {}, textgenerationwebui_settings: { server_urls: {} } }));
vi.mock('../core/../../../../openai.js', () => ({ oai_settings: {} }));
vi.mock('../../../shared.js', () => ({ isWebLlmSupported: () => true }));
vi.mock('../providers/webllm.js', () => ({ getWebLlmProvider: () => ({ embedTexts: mocks.embedTexts }) }));
vi.mock('../backends/backend-manager.js', () => ({
    getBackend: async () => ({ queryMultipleCollections: mocks.backendQuery }),
    invalidateBackendHealth: vi.fn(), recordQuery: vi.fn(), recordInsert: vi.fn(),
    recordDelete: vi.fn(), recordError: vi.fn(),
}));

import { queryMultipleCollections } from '../core/core-vector-api.js';
import { indexLexicalItems, purgeAllLexicalIndexes } from '../core/lexical-index.js';
import { collectionStorageKey } from '../core/collection-portability.js';

describe('core multi-collection query embedding', () => {
    it('generates a client query embedding once and shares it with the backend operation', async () => {
        await queryMultipleCollections(['one', 'two', 'three'], 'needle', 5, 0, {
            source: 'webllm', webllm_model: 'test',
        });

        expect(mocks.embedTexts).toHaveBeenCalledOnce();
        expect(mocks.backendQuery).toHaveBeenCalledOnce();
        expect(mocks.backendQuery.mock.calls[0][5]).toEqual([0.1, 0.2]);
    });

    it('does not shrink a large candidate request to the generic overfetch cap', async () => {
        mocks.backendQuery.mockClear();

        await queryMultipleCollections(['one'], 'needle', 500, 0, { source: 'openai' });

        expect(mocks.backendQuery.mock.calls[0][2]).toBe(500);
    });

    it('uses explicit lexical-only retrieval without embedding or dense requests and honors topK', async () => {
        purgeAllLexicalIndexes();
        mocks.embedTexts.mockClear();
        mocks.backendQuery.mockClear();
        const settings = { source: 'webllm', retrieval_mode: 'lexical_only' };
        indexLexicalItems(collectionStorageKey('one', settings), [
            { hash: 1, text: 'needle needle first' }, { hash: 2, text: 'needle second' },
        ]);

        const result = await queryMultipleCollections(['one'], 'needle', 1, 0, settings);

        expect(result.one.hashes).toEqual([1]);
        expect(result.one.metadata[0]).toMatchObject({ retrievalMode: 'lexical-only' });
        expect(result.one.metadata[0].score).toBeUndefined();
        expect(mocks.embedTexts).not.toHaveBeenCalled();
        expect(mocks.backendQuery).not.toHaveBeenCalled();
    });
});
