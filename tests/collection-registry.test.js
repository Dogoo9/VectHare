import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/core-vector-api.js', () => ({
    getSavedHashes: vi.fn(), queryCollection: vi.fn(), purgeVectorIndex: vi.fn(),
}));
vi.mock('../core/../../../../extensions.js', () => ({
    extension_settings: {}, getContext: () => ({}),
}));
vi.mock('../core/../../../../../script.js', () => ({
    getRequestHeaders: () => ({}), saveSettingsDebounced: vi.fn(),
    characters: [], substituteParams: value => value,
    getCurrentChatId: () => 'chat-1', chat_metadata: {},
}));
vi.mock('../core/../../../../utils.js', () => ({ getStringHash: vi.fn() }));
vi.mock('../core/providers.js', () => ({ getModelField: () => null }));

import { extension_settings } from '../core/../../../../extensions.js';
import {
    cleanupCollectionRegistry, getCollectionRegistry, registerCollection,
} from '../core/collection-loader.js';
import { QdrantBackend } from '../backends/qdrant.js';

describe('collection registry identity after editing', () => {
    beforeEach(() => {
        extension_settings.vecthare = { vecthare_collection_registry: [], collections: {} };
    });
    afterEach(() => vi.unstubAllGlobals());

    it('does not add a bare registration when re-inserting an edited Qdrant entry', async () => {
        const id = 'vecthare_document_notes_123';
        const key = `qdrant:transformers:${id}`;
        registerCollection(key);
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));

        await new QdrantBackend().insertVectorItems(id, [
            { hash: 2, text: 'Edited entry', index: 0 },
        ], { source: 'transformers' });

        expect(getCollectionRegistry()).toEqual([key]);
    });

    it('registers new Qdrant collections with the same identity discovery uses', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true })));
        await new QdrantBackend().insertVectorItems('notes', [
            { hash: 1, text: 'Entry', index: 0 },
        ], { source: 'openai' });
        expect(getCollectionRegistry()).toEqual(['qdrant:openai:notes']);
    });

    it('reuses a unique namespaced collection for bare and legacy registrations', () => {
        registerCollection('qdrant:openai:notes');
        registerCollection('notes');
        registerCollection('openai:notes');
        expect(getCollectionRegistry()).toEqual(['qdrant:openai:notes']);
    });

    it('cleans existing aliases without requiring backend discovery or a restart', () => {
        extension_settings.vecthare.vecthare_collection_registry = [
            'notes', 'qdrant:openai:notes', 'openai:notes', 'notes', null,
        ];
        expect(cleanupCollectionRegistry()).toBe(4);
        expect(getCollectionRegistry()).toEqual(['qdrant:openai:notes']);
    });

    it('replaces a legacy alias when its full registration becomes available', () => {
        registerCollection('notes');
        registerCollection('qdrant:openai:notes');
        expect(getCollectionRegistry()).toEqual(['qdrant:openai:notes']);
    });

    it('keeps distinct backend and source namespaces and leaves ambiguous legacy IDs unresolved', () => {
        const keys = ['qdrant:openai:notes', 'lancedb:openai:notes', 'qdrant:ollama:notes'];
        keys.forEach(registerCollection);
        registerCollection('notes');
        expect(getCollectionRegistry()).toEqual([...keys, 'notes']);
    });
});
