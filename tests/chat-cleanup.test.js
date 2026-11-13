import { beforeEach, describe, expect, it, vi } from 'vitest';

const { deleteCollection, context, registry } = vi.hoisted(() => ({
    deleteCollection: vi.fn(async () => ({ success: true, errors: [] })),
    context: { characterId: 0, characters: [{ avatar: 'alice.png' }], name2: 'Alice' },
    registry: [],
}));

vi.mock('../core/../../../../extensions.js', () => ({
    extension_settings: { vecthare: { collections: {} } },
    getContext: () => context,
}));
vi.mock('../core/collection-loader.js', () => ({
    getCollectionRegistry: () => registry,
    deleteCollection,
}));

import { extension_settings } from '../core/../../../../extensions.js';
import { findChatCollections, purgeDeletedChatCollections, tagChatCollection } from '../core/chat-cleanup.js';

describe('chat collection cleanup', () => {
    beforeEach(() => {
        extension_settings.vecthare.collections = {};
        registry.length = 0;
        deleteCollection.mockClear();
        context.groupId = undefined;
    });

    it('tags a collection with its chat file and owner', () => {
        tagChatCollection('qdrant:openai:vecthare_chat_alice_uuid1', 'Alice - 1');
        const meta = extension_settings.vecthare.collections['qdrant:openai:vecthare_chat_alice_uuid1'];
        expect(meta.chatId).toBe('Alice - 1');
        expect(meta.chatOwner).toBe('char:alice.png');
    });

    it('finds tagged and legacy collections but not other owners', () => {
        extension_settings.vecthare.collections = {
            'standard:transformers:vecthare_chat_alice_u1': { chatId: 'c1', chatOwner: 'char:alice.png' },
            'standard:transformers:vecthare_chat_bob_u2': { chatId: 'c1', chatOwner: 'char:bob.png' },
            'standard:transformers:vecthare_chat_alice_u3': { chatId: 'c2', chatOwner: 'char:alice.png' },
        };
        registry.push('standard:transformers:vecthare_chat_c1', 'standard:transformers:vecthare_chat_alice_u1');
        expect(findChatCollections('c1', 'char:alice.png').sort()).toEqual([
            'standard:transformers:vecthare_chat_alice_u1',
            'standard:transformers:vecthare_chat_c1',
        ]);
    });

    it('deletes matching collections using the backend and source from the key', async () => {
        extension_settings.vecthare.collections = {
            'qdrant:openai:vecthare_chat_alice_u1': { chatId: 'c1', chatOwner: 'char:alice.png' },
        };
        const deleted = await purgeDeletedChatCollections('c1', { vector_backend: 'standard', source: 'transformers' });
        expect(deleted).toEqual(['qdrant:openai:vecthare_chat_alice_u1']);
        const [id, settings, key] = deleteCollection.mock.calls[0];
        expect(id).toBe('vecthare_chat_alice_u1');
        expect(settings).toMatchObject({ vector_backend: 'qdrant', source: 'openai' });
        expect(key).toBe('qdrant:openai:vecthare_chat_alice_u1');
    });
});
