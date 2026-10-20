import { extension_settings } from '../../../../extensions.js';
import { parseRegistryKey } from './collection-ids.js';
import { collectionStorageKey, fingerprintKey, storageSettings, compareEmbeddingFingerprints } from './collection-portability.js';

const modelFields = { webllm: 'webllm_model', ollama: 'ollama_model', openai: 'openai_model', cohere: 'cohere_model', vllm: 'vllm_model', palm: 'google_model', vertexai: 'google_model' };

/** Resolve only unambiguous aliases. Qualified names cannot borrow peer metadata. */
export function storedCollectionKey(id, collections = extension_settings?.vecthare?.collections || {}) {
    if (Object.hasOwn(collections, id)) return id;
    const parsed = parseRegistryKey(id);
    const scopedRegistry = (extension_settings.vecthare?.vecthare_collection_registry || []).filter(k => parseRegistryKey(k).backend && parseRegistryKey(k).collectionId === parsed.collectionId);
    const matches = Object.keys(collections).filter(key => {
        const other = parseRegistryKey(key);
        if (parsed.backend && !other.backend && scopedRegistry.length > 1) return false;
        const locator = collections[key]?.storageLocator;
        if (locator && ((parsed.backend && parsed.backend !== locator.backend && !(parsed.backend === 'standard' && locator.backend === 'vectra')) || (parsed.source && parsed.source !== locator.source))) return false;
        return parsed.collectionId === other.collectionId &&
            (!parsed.backend || !other.backend || parsed.backend === other.backend) &&
            (!parsed.source || !other.source || parsed.source === other.source);
    });
    if (matches.length > 1) throw new Error(`Ambiguous collection ID: ${id}. Select its physical namespace.`);
    return matches[0] || null;
}

export function resolveCollectionSettings(id, settings = {}) {
    if (settings._collectionResolved) return settings;
    const key = storedCollectionKey(id);
    const meta = key ? extension_settings.vecthare.collections[key] : {};
    const registry = extension_settings.vecthare?.vecthare_collection_registry || [];
    const matches = registry.filter(k => parseRegistryKey(k).backend && parseRegistryKey(k).collectionId === parseRegistryKey(id).collectionId);
    if (!parseRegistryKey(id).backend && matches.length > 1) throw new Error(`Ambiguous collection ID: ${id}. Select its physical namespace.`);
    const parsed = parseRegistryKey(parseRegistryKey(id).backend ? id : matches[0] || key || id);
    const connection = meta.embeddingConnection;
    const locator = settings.collection_locator || settings.storageLocator || meta.storageLocator || (parsed.backend ? {
        backend: parsed.backend === 'vectra' ? 'standard' : parsed.backend,
        source: parsed.source, model: meta.preferredModel ?? settings.model ?? settings[modelFields[parsed.source]] ?? '', collectionId: parsed.collectionId,
    } : null);
    if ((meta.retrievalMode || settings.retrieval_mode) !== 'lexical_only' && connection && compareEmbeddingFingerprints(meta.embedding?.fingerprint, connection.fingerprint).status !== 'compatible') {
        throw new Error('Saved embedding profile differs from stored vector provenance. Re-test or rebuild.');
    }
    return {
        ...settings, ...(locator && !connection ? { source: locator.source } : {}), ...(connection ? { source: connection.source, use_alt_endpoint: true, alt_endpoint_url: connection.endpoint,
            local_embedding_profile: { ...connection, probes: meta.embedding?.probes }, embedding_fingerprint: connection.fingerprint, embeddingCompatibility: meta.embedding?.compatibility } : {}),
        collection_locator: locator, retrieval_mode: meta.retrievalMode || settings.retrieval_mode, _collectionResolved: true,
    };
}

export function physicalCollectionId(id, settings) {
    return settings.collection_locator?.collectionId || settings.storageLocator?.collectionId || parseRegistryKey(id).collectionId || id;
}

/** Use the selected physical namespace for local metadata as well as storage. */
export function collectionMetadataKey(id, settings = {}) {
    const locator = settings.collection_locator || settings.storageLocator;
    if (!id && !locator?.collectionId) return null;
    if (!locator) return storedCollectionKey(id) || id;
    const backend = locator.backend === 'vectra' ? 'standard' : locator.backend;
    return `${backend}:${locator.source}:${locator.collectionId}`;
}

export function embeddingProfileKey(settings) {
    const routed = storageSettings(settings);
    return JSON.stringify([routed.vector_backend || 'standard', routed.source, routed.model ?? '',
        settings.retrieval_mode, settings.source, settings.local_embedding_profile || settings.alt_endpoint_url || '', fingerprintKey(settings.embedding_fingerprint),
        ...Object.values(modelFields).map(f => settings[f] || '')]);
}

const locks = new Set();
const active = new Map();
export async function collectionMutation(id, settings, fn) {
    const key = collectionStorageKey(id, settings);
    if (locks.has(key)) throw new Error('Collection migration is in progress; auto-sync and edits are paused.');
    const pending = Promise.resolve().then(fn);
    const operations = active.get(key) || new Set();
    operations.add(pending); active.set(key, operations);
    try { return await pending; } finally { operations.delete(pending); if (!operations.size) active.delete(key); }
}

/** Drain in-flight writes before taking a snapshot; source stays readable. */
export async function lockCollections(entries) {
    const keys = entries.map(({ id, settings }) => collectionStorageKey(id, settings));
    if (keys.some(k => locks.has(k))) throw new Error('A migration already owns this collection.');
    keys.forEach(k => locks.add(k));
    await Promise.allSettled(keys.flatMap(k => [...(active.get(k) || [])]));
    return () => keys.forEach(k => locks.delete(k));
}
