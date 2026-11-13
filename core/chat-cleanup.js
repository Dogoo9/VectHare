/**
 * Links chat collections to the chat file they were built from, so their
 * vectors can be removed when SillyTavern deletes that chat.
 *
 * Chat collection IDs are derived from chat_metadata.integrity, which is no
 * longer readable once a chat has been deleted; the delete events only carry
 * the chat file name. Recording the file name (and owning character/group) on
 * the collection metadata while the chat is open bridges that gap.
 */

import { getCurrentChatId } from '../../../../../script.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import { getCollectionMeta, setCollectionMeta } from './collection-metadata.js';
import { getCollectionRegistry, deleteCollection } from './collection-loader.js';
import { buildChatCollectionId, buildLegacyChatCollectionId, parseRegistryKey } from './collection-ids.js';

/**
 * Identifies the character or group that owns the current chat.
 * @param {object} [context]
 * @returns {string|null}
 */
export function currentChatOwner(context = getContext()) {
    if (context?.groupId) return `group:${context.groupId}`;
    const avatar = context?.characters?.[context?.characterId]?.avatar;
    return avatar ? `char:${avatar}` : null;
}

/**
 * Records which chat file a chat collection belongs to. No-op when unchanged.
 * @param {string} registryKey backend:source:collectionId
 * @param {string} [chatId] Chat file name, defaults to the open chat
 */
export function tagChatCollection(registryKey, chatId = getCurrentChatId()) {
    if (!registryKey || !chatId) return;
    const owner = currentChatOwner();
    const meta = getCollectionMeta(registryKey);
    if (meta.chatId === chatId && (meta.chatOwner ?? null) === owner) return;
    setCollectionMeta(registryKey, { chatId, chatOwner: owner });
}

/**
 * Tags every registered collection of the open chat. Called on chat change so
 * collections created before chat tagging existed are linked too.
 */
export function tagOpenChatCollections() {
    const chatId = getCurrentChatId();
    const collectionId = chatId ? buildChatCollectionId() : null;
    if (!collectionId) return;
    for (const key of getCollectionRegistry()) {
        if (parseRegistryKey(key).collectionId === collectionId) tagChatCollection(key, chatId);
    }
}

/**
 * Returns the registry keys of collections built from a chat file.
 * Collections tagged with a different owner are excluded, because chat file
 * names are only unique per character/group.
 * @param {string} chatId Chat file name
 * @param {string|null} owner Owner from currentChatOwner()
 * @returns {string[]}
 */
export function findChatCollections(chatId, owner) {
    if (!chatId) return [];
    const collections = extension_settings.vecthare?.collections || {};
    const keys = new Set();

    for (const [key, meta] of Object.entries(collections)) {
        if (meta?.chatId !== chatId) continue;
        if (owner && meta.chatOwner && meta.chatOwner !== owner) continue;
        keys.add(key);
    }

    // Collections created before UUID-based IDs used the chat file name directly.
    const legacyId = buildLegacyChatCollectionId(chatId);
    for (const key of getCollectionRegistry()) {
        if (parseRegistryKey(key).collectionId === legacyId) keys.add(key);
    }
    return [...keys];
}

/**
 * Deletes the vectors, registry entry and metadata of every collection built
 * from a deleted chat.
 * @param {string} chatId Chat file name from CHAT_DELETED / GROUP_CHAT_DELETED
 * @param {object} settings VectHare settings
 * @returns {Promise<string[]>} Registry keys that were fully deleted
 */
export async function purgeDeletedChatCollections(chatId, settings) {
    const deleted = [];
    for (const registryKey of findChatCollections(chatId, currentChatOwner())) {
        const parsed = parseRegistryKey(registryKey);
        const meta = getCollectionMeta(registryKey);
        const backend = parsed.backend || settings.vector_backend || 'standard';
        const source = parsed.source || settings.source;
        const collectionSettings = {
            ...settings,
            vector_backend: backend,
            source,
            collection_locator: meta.storageLocator || { backend, source, collectionId: parsed.collectionId },
        };
        try {
            const result = await deleteCollection(parsed.collectionId, collectionSettings, registryKey);
            if (result.success) deleted.push(registryKey);
            else console.warn(`VectHare: Partial cleanup of ${registryKey}:`, result.errors);
        } catch (error) {
            console.warn(`VectHare: Failed to clean up ${registryKey}:`, error);
        }
    }
    return deleted;
}
