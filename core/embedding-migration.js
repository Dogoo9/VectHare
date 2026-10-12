import { extension_settings } from '../../../../extensions.js';
import { getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { getBackend } from '../backends/backend-manager.js';
import { getStorageHashes } from './storage-hashes.js';
import { getAdditionalArgs } from './core-vector-api.js';
import { getCollectionMeta, setCollectionMeta, deleteCollectionMeta } from './collection-metadata.js';
import { registerCollection, unregisterCollection } from './collection-loader.js';
import { compareEmbeddingFingerprints, compareEmbeddingProbes, createEmbeddingFingerprint, rebuildCollection, storageSettings, collectionStorageKey } from './collection-portability.js';
import { lockCollections, resolveCollectionSettings, physicalCollectionId } from './collection-runtime.js';
import { indexLexicalItems, purgeLexicalIndex } from './lexical-index.js';
import { embeddingUrl, probeLocal } from '../providers/local-embeddings.js';

/** Saved/exportable endpoint profile: credentials are runtime-only. */
export function safeEmbeddingProfile(profile) {
    if (!['koboldcpp', 'llamacpp'].includes(profile?.source)) throw new Error('Select KoboldCpp or a local OpenAI-compatible llama.cpp endpoint.');
    embeddingUrl(profile.endpoint);
    const fingerprint = createEmbeddingFingerprint(profile.fingerprint);
    if (fingerprint.textCleaning && !['none', 'strip-markdown-html'].includes(fingerprint.textCleaning)) throw new Error('Unsupported text preprocessing.');
    return { source: profile.source, endpoint: profile.endpoint, model: String(profile.model || 'default'), fingerprint,
        ...(profile.probes ? { probes: structuredClone(profile.probes) } : {}),
        ...(profile.reportedModel ? { reportedModel: String(profile.reportedModel) } : {}) };
}

export function migrationPreview(meta, candidate) {
    const comparison = compareEmbeddingFingerprints(meta.embedding?.fingerprint, candidate.fingerprint);
    return { ...comparison, source: meta.storageLocator, currentConnection: meta.embeddingConnection,
        chunks: meta.collectionSize, requiresRebuild: comparison.status !== 'compatible',
        warning: '768 dimensions and matching filenames do not establish compatibility. Unknown historical provenance requires rebuilding.' };
}

/** Only historical probes tied to the stored fingerprint can certify reassignment. */
export async function testEmbeddingConnection(meta, candidate, options = {}) {
    const profile = safeEmbeddingProfile(candidate);
    const comparison = compareEmbeddingFingerprints(meta.embedding?.fingerprint, profile.fingerprint);
    const observed = await probeLocal(profile, options);
    const probes = meta.embedding?.probes;
    const probeCheck = comparison.status === 'compatible'
        ? compareEmbeddingProbes(probes, observed.probes, profile.fingerprint.dimension)
        : comparison;
    return { ...probeCheck, profile: { ...profile, ...observed } };
}

export async function reassignEmbeddingConnection(key, locator, tested, { confirmed = false, originalConnection = null } = {}) {
    if (!confirmed) throw new Error('Explicit confirmation is required to switch embedding inference.');
    const meta = getCollectionMeta(key);
    const comparison = compareEmbeddingFingerprints(meta.embedding?.fingerprint, tested?.profile?.fingerprint);
    const probeCheck = compareEmbeddingProbes(meta.embedding?.probes, tested?.profile?.probes, meta.embedding?.fingerprint?.dimension);
    if (tested?.status !== 'compatible' || comparison.status !== 'compatible' || probeCheck.status !== 'compatible') throw new Error('Compatibility is unknown or incompatible. Rebuild from text.');
    if (meta.storageLocator && collectionStorageKey(key, { collection_locator: meta.storageLocator }) !== collectionStorageKey(key, { collection_locator: locator })) throw new Error('The physical collection locator cannot change during reassignment.');
    const frozen = structuredClone(meta.storageLocator || locator);
    if ((frozen.backend === 'standard' || frozen.backend === 'vectra') && !['koboldcpp', 'webllm'].includes(frozen.source) && !(await getBackend(storageSettings({ collection_locator: frozen }))).pluginAvailable) throw new Error('This native storage namespace does not accept precomputed query vectors. Rebuild into webllm or apply the documented upstream change.');
    const unlock = await lockCollections([{ id: frozen.collectionId, settings: { collection_locator: frozen } }]);
    try {
        setCollectionMeta(key, { storageLocator: frozen, previousEmbeddingConnection: {
            connection: meta.embeddingConnection || (originalConnection ? safeEmbeddingProfile(originalConnection) : null), embedding: meta.embedding,
        }, embeddingConnection: safeEmbeddingProfile(tested.profile), embedding: { ...meta.embedding, compatibility: 'compatible' } });
    } finally { unlock(); }
}

export function rollbackEmbeddingConnection(key, { confirmed = false } = {}) {
    if (!confirmed) throw new Error('Explicit rollback confirmation is required.');
    const meta = getCollectionMeta(key);
    if (!meta.previousEmbeddingConnection) throw new Error('No previous embedding connection is saved.');
    setCollectionMeta(key, { embeddingConnection: meta.previousEmbeddingConnection.connection,
        embedding: meta.previousEmbeddingConnection.embedding, previousEmbeddingConnection: null });
}

export async function readMigrationItems(id, settings, signal) {
    const routed = storageSettings(settings);
    const hashes = await getStorageHashes(id, routed);
    const items = [];
    for (let offset = 0; offset < hashes.length; offset += 500) {
        signal?.throwIfAborted();
        const backend = await getBackend({ ...routed, _storageReadOnly: true });
        const data = await backend.listChunks(id, routed, { offset, limit: 500, includeVectors: true });
        if (!Array.isArray(data.items) || data.total !== hashes.length) throw new Error('Invalid or changing migration chunk count. Retry the snapshot.');
        items.push(...data.items.map(item => {
            const metadata = item.metadata || {};
            return { ...item, ...metadata, hash: metadata.hash ?? item.hash, text: metadata.text ?? item.text,
                index: metadata.index ?? item.index, metadata: { ...metadata } };
        }));
    }
    if (items.length !== hashes.length || new Set(items.map(i => String(i.hash))).size !== hashes.length ||
        !hashes.every(h => items.some(i => String(i.hash) === String(h)))) throw new Error('Incomplete or duplicate migration snapshot. No source data was changed.');
    if (items.some(i => typeof i.text !== 'string' || !i.text.trim())) throw new Error('Missing recoverable text; migration cannot proceed.');
    return items;
}

function stable(value) {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, stable(value[k])]));
    return value;
}
export function verifyMigrationContent(expected, actual) {
    const byHash = new Map(actual.map(item => [String(item.hash), item]));
    if (actual.length !== expected.length || byHash.size !== expected.length) return { ok: false, reason: 'Target count/identifiers differ.' };
    for (const item of expected) {
        const found = byHash.get(String(item.hash));
        if (!found || found.text !== item.text || found.index !== item.index) return { ok: false, reason: 'Target text or stable chunk ordering differs.' };
        for (const [field, value] of Object.entries(item.metadata || {})) {
            if (['text', 'hash', 'index', 'vector'].includes(field)) continue;
            if (JSON.stringify(stable(found.metadata?.[field])) !== JSON.stringify(stable(value))) return { ok: false, reason: `Target metadata differs: ${field}.` };
        }
        const check = compareEmbeddingProbes({ document: item.vector, query: item.vector }, { document: found.vector, query: found.vector }, item.vector?.length);
        if (check.status !== 'compatible') return { ok: false, reason: 'Target stored vectors differ from the generated vectors.' };
    }
    return { ok: true };
}

function cosine(a, b) {
    return a.reduce((sum, n, i) => sum + n * b[i], 0) / Math.sqrt(a.reduce((s, n) => s + n * n, 0) * b.reduce((s, n) => s + n * n, 0));
}

/** Non-destructive staging: targets remain disabled until an explicit, verified cutover. */
export async function migrateEmbeddingCollection({ key, locator, settings, candidate, targetId, signal, onProgress, batchSize = 10, confirmed = false }, adapters = {}) {
    if (!confirmed) throw new Error('Explicit rebuild confirmation is required.');
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(targetId || '') || targetId === locator.collectionId) throw new Error('Choose a distinct target ID containing letters, numbers, underscores or hyphens.');
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 512) throw new Error('Invalid migration batch size.');
    if (locator.backend === 'milvus') throw new Error('The current Milvus adapter uses a shared vecthare_main index. A distinct physical migration target requires an upstream backend change.');
    const profile = safeEmbeddingProfile(candidate);
    const comparison = compareEmbeddingFingerprints(profile.fingerprint, profile.fingerprint);
    if (comparison.status !== 'compatible') throw new Error('A rebuild requires a complete target embedding fingerprint.');
    const sourceSettings = resolveCollectionSettings(key, { ...settings, collection_locator: locator });
    const sourceId = physicalCollectionId(key, sourceSettings);
    // Native ST consumes precomputed embeddings under webllm. This is a new,
    // explicit storage namespace, independent of the selected inference provider.
    const targetLocator = { ...locator, collectionId: targetId, source: locator.backend === 'standard' || locator.backend === 'vectra' ? 'webllm' : locator.source,
        model: profile.model };
    const targetKey = `${targetLocator.backend}:${targetLocator.source}:${targetId}`;
    const targetSettings = { ...settings, _collectionResolved: true, source: profile.source, collection_locator: targetLocator,
        local_embedding_profile: profile, embedding_fingerprint: profile.fingerprint, embeddingCompatibility: 'compatible', embedding_signal: signal };
    const targetRouted = storageSettings(targetSettings);
    if ((locator.backend === "qdrant" && settings.qdrant_multitenancy)) throw new Error('Rebuild requires a distinct physical index. Disable Qdrant multitenancy for this operation.');
    const backend = adapters.backend || await getBackend(targetRouted);
    const read = adapters.read || readMigrationItems;
    const unlock = await lockCollections([{ id: sourceId, settings: sourceSettings }, { id: targetId, settings: targetSettings }]);
    let ownsTarget = false;
    try {
        signal?.throwIfAborted();
        if (Object.keys(extension_settings.vecthare?.collections || {}).some(k => physicalCollectionId(k, resolveCollectionSettings(k, settings)) === targetId)) throw new Error('Target ID already exists in settings.');
        // Discover collisions before writing. Empty indexes must also be reserved.
        if (adapters.assertAbsent) await adapters.assertAbsent(targetId, targetSettings);
        else {
            const response = await fetch('/api/plugins/similharity/collections', { headers: getRequestHeaders(), signal });
            if (!response.ok) throw new Error('Collision-safe rebuild requires Similharity collection discovery.');
            const data = await response.json();
            if (!Array.isArray(data.collections)) throw new Error('Cannot establish that the target ID is unused.');
            if (data.collections.some(c => (c.id || c.collectionId) === targetId)) throw new Error('Target collection already exists. Choose a new ID.');
        }
        const items = await read(sourceId, sourceSettings, signal);
        if (!items.length) throw new Error('Source collection is empty.');
        const meta = structuredClone(getCollectionMeta(key));
        const observed = adapters.probe ? await adapters.probe(profile) : await probeLocal(profile, { signal });
        Object.assign(profile, observed);
        ownsTarget = true;
        setCollectionMeta(targetKey, { ...meta, enabled: false, autoSync: false, previousEmbeddingConnection: null,
            storageLocator: targetLocator, embeddingConnection: profile,
            embedding: { fingerprint: profile.fingerprint, probes: profile.probes, compatibility: 'compatible' },
            migration: { status: 'building', sourceKey: key } });
        registerCollection(targetKey);
        const expected = [];
        const outcome = await rebuildCollection({ source: key, target: targetKey, items, signal, batchSize, onProgress,
            writeBatch: async (_target, batch) => {
                signal?.throwIfAborted();
                const args = adapters.embed ? await adapters.embed(batch, targetSettings) : await getAdditionalArgs(batch.map(i => i.text), targetSettings);
                const writes = batch.map(item => ({ ...item, vector: args.embeddings[item.text] }));
                // Do not retry ambiguous backend writes; cleanup + a new ID gives a clean restart.
                await backend.insertVectorItems(targetId, writes, targetRouted);
                expected.push(...writes);
            },
            verify: async () => {
                const actual = await read(targetId, targetSettings, signal);
                const content = verifyMigrationContent(expected, actual);
                if (!content.ok) return content;
                if (adapters.verifyRanking) return adapters.verifyRanking(expected, targetSettings);
                // Compare backend ranking with exact cosine scores of generated target
                // vectors for three representative texts. Ties at the boundary are allowed.
                if (profile.fingerprint.distanceMetric !== 'cosine') return { ok: false, reason: 'Automatic ranking verification currently requires cosine distance.' };
                for (const item of [expected[0], expected[Math.floor(expected.length / 2)], expected.at(-1)]) {
                    const args = await getAdditionalArgs([item.text], targetSettings, null, 'query');
                    const vector = args.embeddings[item.text];
                    const k = Math.min(5, expected.length);
                    const ranked = expected.map(i => ({ hash: String(i.hash), score: cosine(vector, i.vector) })).sort((a, b) => b.score - a.score);
                    const result = await backend.queryCollection(targetId, item.text, k, { ...targetRouted, score_threshold: 0 }, vector);
                    const acceptable = new Set(ranked.filter(r => r.score >= ranked[k - 1].score - 1e-5).map(r => r.hash));
                    if (result.hashes.length < k || new Set(result.hashes.map(String)).size !== k || result.hashes.some(h => !acceptable.has(String(h)))) return { ok: false, reason: 'Target query rankings differ from generated vectors.' };
                }
                return { ok: true, count: expected.length, content: true, ranking: true };
            },
        });
        signal?.throwIfAborted();
        indexLexicalItems(collectionStorageKey(targetId, targetSettings), expected);
        setCollectionMeta(targetKey, { migration: { status: 'ready', sourceKey: key, verification: outcome.verification }, collectionSize: expected.length });
        registerCollection(targetKey);
        return { ...outcome, targetKey, targetLocator };
    } catch (error) {
        if (ownsTarget) {
            try {
                await backend.purgeVectorIndex(targetId, targetRouted);
                purgeLexicalIndex(collectionStorageKey(targetId, targetSettings));
                unregisterCollection(targetKey); deleteCollectionMeta(targetKey);
            } catch {
                setCollectionMeta(targetKey, { enabled: false, autoSync: false, migration: { status: 'cleanup-required', sourceKey: key } });
                throw new Error('Migration failed and target cleanup failed. The target remains disabled; choose a new ID for restart. Source is intact.');
            }
        }
        throw error;
    } finally { unlock(); }
}

function replacePolicySelection(source, target) {
    for (const policy of Object.values(extension_settings.vecthare?.chatCollectionPolicies || {})) {
        policy.selectedCollections = (policy.selectedCollections || []).map(k => k === source ? target : k);
    }
    saveSettingsDebounced();
}
export function cutoverEmbeddingMigration(sourceKey, targetKey, { confirmed = false } = {}) {
    const source = getCollectionMeta(sourceKey);
    const target = getCollectionMeta(targetKey);
    if (!confirmed || target.migration?.status !== 'ready' || target.migration.sourceKey !== sourceKey || !target.migration.verification?.ok) throw new Error('Only a confirmed, verified migration can be activated.');
    setCollectionMeta(targetKey, { enabled: source.enabled, autoSync: false, migration: { ...target.migration, status: 'active', sourceState: { enabled: source.enabled, autoSync: source.autoSync } } });
    setCollectionMeta(sourceKey, { enabled: false, autoSync: false });
    replacePolicySelection(sourceKey, targetKey);
}
export function rollbackEmbeddingMigration(targetKey, { confirmed = false } = {}) {
    const target = getCollectionMeta(targetKey);
    if (!confirmed || target.migration?.status !== 'active') throw new Error('Confirm rollback of an active migration.');
    const { sourceKey, sourceState } = target.migration;
    setCollectionMeta(sourceKey, sourceState);
    setCollectionMeta(targetKey, { enabled: false, autoSync: false, migration: { ...target.migration, status: 'ready' } });
    replacePolicySelection(targetKey, sourceKey);
}
