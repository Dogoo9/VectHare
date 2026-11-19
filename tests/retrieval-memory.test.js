import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMultipleCollections, insertVectorItems, setExtensionPrompt, context, prompts } = vi.hoisted(() => ({
    queryMultipleCollections: vi.fn(),
    insertVectorItems: vi.fn(),
    setExtensionPrompt: vi.fn(),
    context: { chat: [], name2: 'Alice', characterId: 0, characters: [{ avatar: 'alice.png' }] },
    prompts: {},
}));

vi.mock('../backends/backend-manager.js', () => ({ isBackendAvailable: vi.fn(() => true) }));
vi.mock('../core/../../../../../script.js', () => ({
    getCurrentChatId: vi.fn(() => 'chat-1'), is_send_press: false, chat_metadata: { integrity: 'uuid-1' },
    setExtensionPrompt: (tag, value, position, depth) => {
        prompts[tag] = { value, position, depth };
        setExtensionPrompt(tag, value, position, depth);
    },
    extension_prompts: prompts, extension_prompt_types: { IN_PROMPT: 0, IN_CHAT: 1 },
    substituteParams: value => value, getRequestHeaders: vi.fn(() => ({})), saveSettingsDebounced: vi.fn(),
}));
vi.mock('../core/../../../../extensions.js', () => ({
    extension_settings: { vecthare: { collections: { lore: { alwaysActive: true } }, vecthare_collection_registry: ['lore'] } },
    getContext: () => context,
}));
vi.mock('../core/../../../../utils.js', () => ({
    getStringHash: value => [...String(value)].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) | 0, 7),
    waitUntilCondition: vi.fn(), onlyUnique: vi.fn(),
}));
vi.mock('../core/core-vector-api.js', () => ({
    getSavedHashes: vi.fn(async () => []), insertVectorItems, queryMultipleCollections,
    queryActiveCollections: vi.fn(), deleteVectorItems: vi.fn(), purgeVectorIndex: vi.fn(),
}));

import { getStringHash } from '../core/../../../../utils.js';
import { selectFinalChunks } from '../core/retrieval-budget.js';
import {
    buildKeywordScanText, buildSearchQueries, getChatCollectionId, markMemoryKeywordMatches, queryAndMergeCollections,
    rearrangeChat, readSummaryKeywordText, readSummaryMemory, resetStickyLore, selectRecallChunks, synchronizeChat,
} from '../core/chat-vectorization.js';

const base = { position: 0, depth: 2, top_k: 2, score_threshold: 0, deduplication_depth: 0, keyword_extraction_level: 'off' };
const hit = (hash, score) => ({ text: `Lore ${hash}`, score });
const lore = rows => ({ lore: { hashes: rows.map(r => r[0]), metadata: rows.map(([hash, score]) => hit(hash, score)) } });
const turn = (user, reply) => [{ is_user: true, mes: user }, { is_user: false, mes: reply }];
const generate = (settings = base) => rearrangeChat(context.chat.filter(m => !m.is_system), settings, 'normal');

beforeEach(() => {
    vi.clearAllMocks();
    resetStickyLore();
    for (const key of Object.keys(prompts)) delete prompts[key];
    globalThis.window = {};
    globalThis.toastr = { error: vi.fn() };
    context.chat = [...turn('first', 'reply one'), { is_user: true, mes: 'second' }];
});

describe('search queries', () => {
    it('searches the user message and only the end of the latest reply', () => {
        expect(buildSearchQueries([...turn('old', 'x'.repeat(10) + 'tail'), { is_user: true, mes: 'now', extra: {} }], { query_tail_chars: 4 }))
            .toEqual(['now', 'tail']);
    });

    it('works when one side is missing and ignores hidden messages', () => {
        expect(buildSearchQueries([{ is_user: false, mes: 'greeting' }, { is_user: true, is_system: true, mes: 'hidden' }], {})).toEqual(['greeting']);
    });

    it('scans only recent messages for keywords', () => {
        expect(buildKeywordScanText([{ mes: 'a' }, { mes: 'b' }, { mes: 'c' }], { keyword_scan_messages: 2 })).toBe('b\nc');
        expect(buildKeywordScanText([{ mes: 'a' }], { keyword_scan_messages: 0 })).toBe('');
    });

    it('keeps the best score per chunk and survives one failed search', async () => {
        queryMultipleCollections.mockResolvedValueOnce(lore([[1, 0.2], [2, 0.8]])).mockResolvedValueOnce(lore([[1, 0.9]]));
        const merged = await queryAndMergeCollections(['lore'], ['a', 'b'], { top_k: 5 }, [], { trace: [], chunkFates: {} });
        expect(merged.map(c => [c.hash, c.score])).toEqual([[1, 0.9], [2, 0.8]]);

        queryMultipleCollections.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(lore([[3, 0.5]]));
        const partial = await queryAndMergeCollections(['lore'], ['a', 'b'], { top_k: 5 }, [], { trace: [], chunkFates: {} });
        expect(partial.map(c => c.hash)).toEqual([3]);
    });
});

describe('sticky lore', () => {
    it('reinjects identical sorted text until history is rewritten', async () => {
        queryMultipleCollections.mockResolvedValue(lore([[2, 0.9], [1, 0.8]]));
        await generate();
        const first = prompts['3_vecthare'].value;
        expect(first.indexOf('Lore 1')).toBeLessThan(first.indexOf('Lore 2'));

        queryMultipleCollections.mockResolvedValue(lore([[3, 0.99], [1, 0.8]]));
        context.chat.push({ is_user: false, mes: 'reply two' }, { is_user: true, mes: 'third' });
        await generate();
        expect(prompts['3_vecthare'].value).toBe(first);
        expect(prompts['3_vecthare_delta']).toMatchObject({ value: 'Lore 3', position: 1, depth: 1 });

        context.chat[0].is_system = true;
        await generate();
        expect(prompts['3_vecthare'].value).toContain('Lore 3');
        expect(prompts['3_vecthare_delta'].value).toBe('');
    });

    it('does not age on regenerate but refreshes after the turn limit', async () => {
        const settings = { ...base, sticky_max_age_turns: 1 };
        queryMultipleCollections.mockResolvedValue(lore([[1, 0.9]]));
        await generate(settings);
        queryMultipleCollections.mockResolvedValue(lore([[2, 0.9]]));
        await generate(settings);
        expect(prompts['3_vecthare'].value).toBe('Lore 1');
        context.chat.push({ is_user: false, mes: 'reply two' }, { is_user: true, mes: 'third' });
        await generate(settings);
        expect(prompts['3_vecthare'].value).toBe('Lore 2');
    });

    it('keeps injecting the set when a search returns nothing, and never caches an empty pick', async () => {
        queryMultipleCollections.mockResolvedValue(lore([[1, 0.9]]));
        await generate();
        queryMultipleCollections.mockResolvedValue(lore([]));
        await generate();
        expect(prompts['3_vecthare'].value).toBe('Lore 1');

        resetStickyLore();
        await generate();
        queryMultipleCollections.mockResolvedValue(lore([[2, 0.9]]));
        await generate();
        expect(prompts['3_vecthare'].value).toBe('Lore 2');
    });
});

describe('chat recall', () => {
    const ghost = (mes, is_user = false) => ({ mes, is_user, is_system: true, extra: { sc_ghosted: true } });

    it('recalls only live hidden messages within its limits', () => {
        context.chat = [ghost('old fact'), { mes: 'user hid this', is_system: true }, ghost('long'.repeat(50)), { mes: 'visible' }];
        const chunks = ['old fact', 'user hid this', 'long'.repeat(50), 'visible', 'swiped away']
            .map((text, i) => ({ hash: getStringHash(text), text: `stored [KEYWORDS: x] ${text}`, score: 1 - i / 10 }));
        const picked = selectRecallChunks(chunks, [{ mes: 'visible' }], { chat_recall_k: 2, chat_recall_max_chars: 100 });
        expect(picked.map(c => c.text)).toEqual(['[Recalled from earlier in this chat — message 0]\nold fact']);
    });

    it('queries this chat without metadata and injects recalled text at depth 1 outside the sticky block', async () => {
        context.chat = [ghost('the hidden promise'), { is_user: true, mes: 'remember?' }];
        const chatId = getChatCollectionId();
        queryMultipleCollections.mockImplementation(async ids => {
            expect(ids).toContain(chatId);
            return { ...lore([[1, 0.9]]), [chatId]: { hashes: [getStringHash('the hidden promise')], metadata: [{ text: 'stored', score: 0.7, keywords: ['remember'] }] } };
        });
        await generate({ ...base, chat_recall_enabled: true });
        expect(prompts['3_vecthare'].value).toBe('Lore 1');
        expect(prompts['3_vecthare_recall']).toMatchObject({ position: 1, depth: 1 });
        expect(prompts['3_vecthare_recall'].value).toContain('the hidden promise');
    });

    it('syncs hidden Summaryception messages per message, without auto-sync metadata', async () => {
        context.chat = [ghost('hidden'), { mes: 'user hidden', is_system: true }, { mes: 'shown', is_user: true }, { mes: '   ' }];
        const result = await synchronizeChat({ chat_recall_enabled: true, chunking_strategy: 'message_batch', keyword_extraction_level: 'off', vector_backend: 'standard', source: 'openai' }, 5);
        expect(insertVectorItems.mock.calls[0][1].map(item => item.text)).toEqual(['hidden', 'shown']);
        expect(insertVectorItems.mock.calls[0][1][0].metadata.strategy).toBe('per_message');
        expect(result).toMatchObject({ remaining: 0, chunksCreated: 2 });
    });
});

describe('Summaryception memory bridge', () => {
    it('reads the newest whole memory lines and searches them', () => {
        prompts.summaryception = { value: 'header\n- old event\n- newest event' };
        expect(readSummaryMemory({ summary_context_chars: 18 })).toBe('- newest event');
        expect(readSummaryMemory({ summary_context_chars: 0 })).toBe('');
        expect(buildSearchQueries([{ is_user: true, mes: 'now' }], {}, '- newest event')).toEqual(['now', '- newest event']);
    });

    it('ranks entries named in memory between current keywords and semantic hits', () => {
        const chunks = [
            { hash: 1, text: 'semantic', score: 0.9, keywords: [] },
            { hash: 2, text: 'memory', score: 0.1, keywords: ['Mara'] },
            { hash: 3, text: 'current', score: 0.2, keywordForceInjected: true, keywords: ['Mara'] },
        ];
        expect(markMemoryKeywordMatches(chunks, '- Mara left', 0.35)).toBe(1);
        expect(chunks[1]).toMatchObject({ memoryKeywordMatched: true, score: 0.35 });
        expect(selectFinalChunks(chunks, 3).map(chunk => chunk.text)).toEqual(['current', 'memory', 'semantic']);
    });

    it('never drops named entries for the token limit', () => {
        const chunks = [
            { hash: 1, text: 'a'.repeat(4000), score: 0.1, keywordForceInjected: true },
            { hash: 2, text: 'b'.repeat(4000), score: 0.2, memoryKeywordMatched: true },
            { hash: 3, text: 'c'.repeat(400), score: 0.9 },
        ];
        expect(selectFinalChunks(chunks, 3, { maxTokens: 500 }).map(chunk => chunk.hash)).toEqual([1, 2]);
    });

    it('scans twenty messages by default and all of the injected memory', () => {
        const chat = Array.from({ length: 25 }, (_, i) => ({ mes: `m${i}` }));
        expect(buildKeywordScanText(chat, {}).split('\n')).toHaveLength(20);
        prompts.summaryception = { value: 'x'.repeat(5000) + ' Mara' };
        expect(readSummaryKeywordText({ summary_context_chars: 100 })).toContain('Mara');
        expect(readSummaryKeywordText({ summary_context_chars: 0 })).toBe('');
    });

    it('adds a large newly named entry between sticky refreshes', async () => {
        const limited = { ...base, top_k: 5, sticky_delta_max_tokens: 10 };
        queryMultipleCollections.mockResolvedValue(lore([[1, 0.8]]));
        await generate(limited);
        const large = { text: 'Mara '.repeat(2000), score: 0.1, keywords: ['Mara'] };
        queryMultipleCollections.mockResolvedValue({ lore: { hashes: [1, 9], metadata: [hit(1, 0.8), large] } });
        context.chat.push({ is_user: false, mes: 'reply' }, { is_user: true, mes: 'Mara arrives' });
        await generate(limited);
        expect(prompts['3_vecthare_delta'].value).toContain('Mara');
    });

    it('keeps the best lore that fits the token limit', () => {
        const chunks = [{ hash: 1, text: 'a'.repeat(400), score: 0.9 }, { hash: 2, text: 'b'.repeat(4000), score: 0.8 }, { hash: 3, text: 'c'.repeat(400), score: 0.7 }];
        expect(selectFinalChunks(chunks, 3, { maxTokens: 250 }).map(chunk => chunk.hash)).toEqual([1, 3]);
    });
});
