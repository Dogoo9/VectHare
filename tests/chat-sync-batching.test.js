import { beforeEach, describe, expect, it, vi } from 'vitest';

const { insertVectorItems, context } = vi.hoisted(() => ({
    insertVectorItems: vi.fn(),
    context: { chat: [], name2: 'Alice', characterId: 0, characters: [{ avatar: 'alice.png' }] },
}));

vi.mock('../backends/backend-manager.js', () => ({ isBackendAvailable: vi.fn(() => true) }));
vi.mock('../core/../../../../extensions.js', () => ({
    extension_settings: { vecthare: { collections: {}, vecthare_collection_registry: [] } },
    getContext: () => context,
}));
vi.mock('../core/core-vector-api.js', () => ({
    getSavedHashes: vi.fn(async () => []),
    insertVectorItems,
    queryMultipleCollections: vi.fn(),
    deleteVectorItems: vi.fn(),
    purgeVectorIndex: vi.fn(),
}));
vi.mock('../core/collection-metadata.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isCollectionAutoSyncEnabled: () => true,
}));

import { synchronizeChat } from '../core/chat-vectorization.js';

const settings = { vector_backend: 'standard', source: 'openai', chunking_strategy: 'per_message', keyword_extraction_level: 'off' };

describe('synchronizeChat batching', () => {
    beforeEach(() => {
        insertVectorItems.mockReset();
        context.chat = ['one', 'two', 'three'].map(mes => ({ mes, is_user: false }));
    });

    it('inserts a whole batch with a single call', async () => {
        const result = await synchronizeChat(settings, 2);
        expect(insertVectorItems).toHaveBeenCalledTimes(1);
        expect(insertVectorItems.mock.calls[0][1].map(item => item.text)).toEqual(['one', 'two']);
        expect(result).toMatchObject({ remaining: 1, messagesProcessed: 2, chunksCreated: 2, itemsFailed: 0 });
    });

    it('falls back to per-item inserts when the batch fails', async () => {
        insertVectorItems
            .mockRejectedValueOnce(new Error('batch failed'))
            .mockResolvedValueOnce()
            .mockRejectedValueOnce(new Error('bad item'));
        const result = await synchronizeChat(settings, 2);
        expect(insertVectorItems).toHaveBeenCalledTimes(3);
        expect(result).toMatchObject({ messagesProcessed: 2, chunksCreated: 1, itemsFailed: 1 });
    });
});
