import { extension_settings } from '../../../../extensions.js';
import { getRequestHeaders } from '../../../../../script.js';
import { getBackend } from '../backends/backend-manager.js';
import { getCollectionMeta, setCollectionMeta, getChunkMetadata } from './collection-metadata.js';
import { getCollectionRegistry, registerCollection } from './collection-loader.js';
import { lockCollections, physicalCollectionId, resolveCollectionSettings } from './collection-runtime.js';
import { collectionStorageKey, storageSettings } from './collection-portability.js';
import { parseRegistryKey } from './collection-ids.js';
import { readMigrationItems, verifyMigrationContent } from './embedding-migration.js';
import { indexLexicalItems } from './lexical-index.js';

const pendingNames = new Set();
const normalizeBackend = backend => backend === 'vectra' ? 'standard' : backend;
export const DUPLICATION_BACKENDS = Object.freeze({
    standard: 'Standard (Vectra)',
    lancedb: 'LanceDB',
    qdrant: 'Qdrant',
});

// Discovery includes bare IDs, backend:id and backend:source:id forms. Names
// may be reused across backends, but never overwrite a destination on disk.
function destinationExists(record, targetId, targetBackend) {
    const raw = String(record.id || record.collectionId || '');
    const parsed = parseRegistryKey(raw);
    const prefix = /^(standard|vectra|lancedb|qdrant|milvus):/.exec(raw)?.[1];
    const backend = normalizeBackend(record.backend || parsed.backend || prefix);
    const id = parsed.backend ? parsed.collectionId : prefix ? raw.slice(prefix.length + 1) : parsed.collectionId;
    return id === targetId && (!backend || backend === targetBackend);
}

/** Copy stored embeddings verbatim into an independent physical collection. */
export async function duplicateCollection(key, name, settings, { targetBackend, onProgress } = {}) {
    const targetId = String(name || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(targetId)) throw new Error('Use 1–160 letters, numbers, underscores or hyphens for the collection name.');
    const sourceSettings = resolveCollectionSettings(key, settings);
    const sourceId = physicalCollectionId(key, sourceSettings);
    const sourceLocator = sourceSettings.collection_locator || { backend: settings.vector_backend || 'standard', source: settings.source || 'transformers', model: settings.model || '', collectionId: sourceId };
    targetBackend = normalizeBackend(targetBackend || sourceLocator.backend);
    if (!Object.hasOwn(DUPLICATION_BACKENDS, targetBackend)) {
        throw new Error(targetBackend === 'milvus'
            ? 'Milvus uses shared storage and cannot create an independent duplicate. Choose Standard, LanceDB or Qdrant.'
            : 'Unsupported destination backend. Choose Standard, LanceDB or Qdrant.');
    }
    if (settings.qdrant_multitenancy && (sourceLocator.backend === 'qdrant' || targetBackend === 'qdrant')) {
        throw new Error('Turn off Qdrant multitenancy in settings to duplicate a separately named collection.');
    }
    if (normalizeBackend(sourceLocator.backend) === targetBackend && sourceId === targetId) throw new Error('Choose a name different from the source collection.');
    const pendingKey = `${targetBackend}:${targetId}`;
    if (pendingNames.has(pendingKey)) throw new Error('A duplicate with that name is already being created.');
    const locator = { ...sourceLocator, backend: targetBackend, collectionId: targetId };
    const targetKey = `${targetBackend}:${locator.source}:${targetId}`;
    const targetSettings = { ...sourceSettings, vector_backend: targetBackend, collection_locator: locator, storageLocator: null, qdrant_multitenancy: false, _storageReadOnly: false };
    pendingNames.add(pendingKey);
    let unlock;
    let reserved = false;
    try {
        unlock = await lockCollections([{ id: sourceId, settings: sourceSettings }, { id: targetId, settings: targetSettings }]);
        const knownKeys = [...Object.keys(extension_settings.vecthare?.collections || {}), ...getCollectionRegistry()];
        if (knownKeys.some(k => {
            const parsed = parseRegistryKey(k);
            const stored = extension_settings.vecthare?.collections?.[k]?.storageLocator;
            return destinationExists({ id: stored?.collectionId || k, backend: stored?.backend || parsed.backend }, targetId, targetBackend);
        })) throw new Error('Collection name already exists. Choose a new name.');
        // Initialize storage adapters, including Standard's plugin capability,
        // before storage-only enumeration. This does not generate embeddings.
        await getBackend({ ...storageSettings(sourceSettings), _storageReadOnly: false });
        const backend = await getBackend(storageSettings(targetSettings));
        if (targetBackend === 'standard' && !backend.pluginAvailable) {
            throw new Error('Similharity is required to copy and verify stored vectors and metadata in Standard storage.');
        }
        const response = await fetch('/api/plugins/similharity/collections', { headers: getRequestHeaders() });
        if (!response.ok) throw new Error('Similharity collection discovery is required to check the destination name.');
        const data = await response.json();
        if (!Array.isArray(data.collections) || data.success === false) throw new Error('Cannot verify that the destination name is unused.');
        if (data.collections.some(c => destinationExists(c, targetId, targetBackend))) throw new Error('Collection name already exists on disk. Choose a new name.');
        onProgress?.('Reading stored vectors…');
        const items = await readMigrationItems(sourceId, sourceSettings);
        if (!items.length) throw new Error('The source collection is empty.');
        const dimension = items[0].vector?.length;
        if (!dimension || items.some(i => !Array.isArray(i.vector) || i.vector.length !== dimension || !i.vector.every(Number.isFinite) || !i.vector.some(n => n !== 0))) {
            throw new Error('Every chunk must have a valid stored vector of the same dimension to duplicate without re-embedding.');
        }
        const meta = structuredClone(getCollectionMeta(key));
        // Hashes describe content and must stay stable for links and summaries.
        // Snapshot local overrides into the destination's own namespace, including
        // null entries so later legacy changes cannot leak into the duplicate.
        const chunkMetadata = Object.fromEntries(items.map(item => [String(item.hash), getChunkMetadata(item.hash, key)]));
        setCollectionMeta(targetKey, { ...meta, displayName: targetId, storageLocator: locator, enabled: false, autoSync: false,
            chunkMetadata,
            migration: null, previousEmbeddingConnection: null, createdAt: Date.now(),
            importState: { status: 'building', sourceKey: key } });
        reserved = true;
        registerCollection(targetKey);
        for (let offset = 0; offset < items.length; offset += 100) {
            onProgress?.(`Copying ${Math.min(offset + 100, items.length)} / ${items.length} chunks…`);
            await backend.insertVectorItems(targetId, items.slice(offset, offset + 100), storageSettings(targetSettings));
        }
        onProgress?.('Verifying the duplicate…');
        const verification = verifyMigrationContent(items, await readMigrationItems(targetId, targetSettings));
        if (!verification.ok) throw new Error(verification.reason);
        indexLexicalItems(collectionStorageKey(targetId, targetSettings), items);
        setCollectionMeta(targetKey, { collectionSize: items.length, importState: { status: 'ready', sourceKey: key } });
        return { collectionId: targetId, registryKey: targetKey, chunkCount: items.length };
    } catch (error) {
        if (reserved) setCollectionMeta(targetKey, { enabled: false, autoSync: false, importState: { status: 'failed', sourceKey: key, error: error.message } });
        throw error;
    } finally {
        unlock?.();
        pendingNames.delete(pendingKey);
    }
}

/** Compatibility entry point for callers of the original Qdrant-only action. */
export function duplicateCollectionToQdrant(key, name, settings, options = {}) {
    return duplicateCollection(key, name, settings, { ...options, targetBackend: 'qdrant' });
}
