import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../core/core-vector-api.js', () => ({ getAdditionalArgs: vi.fn() }));
vi.mock('../core/collection-loader.js', () => ({ registerCollection: vi.fn(), unregisterCollection: vi.fn() }));
vi.mock('../backends/backend-manager.js', () => ({ getBackend: async () => ({ pluginAvailable: true }) }));
import { extension_settings } from '../../../../extensions.js';
import { getCollectionMeta, setCollectionMeta, isCollectionEnabled } from '../core/collection-metadata.js';
import { resolveCollectionSettings, collectionMutation } from '../core/collection-runtime.js';
import { migrationPreview, safeEmbeddingProfile, testEmbeddingConnection, reassignEmbeddingConnection, rollbackEmbeddingConnection,
    migrateEmbeddingCollection, cutoverEmbeddingMigration, rollbackEmbeddingMigration, verifyMigrationContent } from '../core/embedding-migration.js';
import { profile, probes, fingerprint, response } from './embedding-fixtures.js';

const key = 'standard:koboldcpp:old';
const locator = { backend: 'standard', source: 'koboldcpp', model: 'original-nomic-namespace', collectionId: 'old' };
const meta = () => ({ enabled: true, autoSync: true, storageLocator: locator, embedding: { fingerprint: fingerprint(), probes, compatibility: 'compatible' },
    groups: [{ id: 'g', hashes: [7] }], lockedToChatIds: ['chat-1'], temporalDecay: { enabled: true }, conditions: { enabled: true }, triggers: ['gate'], authority: 3 });
const items = [{ hash: 7, text: 'key', index: 3, vector: [1, 0.5], metadata: { conditions: { rules: ['x'] }, group: 'g', enabled: false, timestamp: 10 } }];

function adapters(options = {}) {
    let stored = [];
    const backend = { insertVectorItems: vi.fn(async (_id, batch) => { stored.push(...structuredClone(batch)); }), purgeVectorIndex: vi.fn(async () => { stored = []; }) };
    return { backend, read: vi.fn(async id => id === 'old' ? structuredClone(items) : structuredClone(stored)),
        assertAbsent: vi.fn(), probe: vi.fn(async () => ({ probes, reportedModel: 'synthetic-nomic' })),
        embed: vi.fn(async batch => ({ embeddings: Object.fromEntries(batch.map(i => [i.text, [1, 0.5]])) })),
        verifyRanking: vi.fn(async () => ({ ok: true, ranking: true })), ...options };
}
const request = overrides => ({ key, locator, settings: { source: 'koboldcpp' }, candidate: profile(), targetId: 'new', confirmed: true, ...overrides });

beforeEach(() => { extension_settings.vecthare = { collections: {}, chatCollectionPolicies: { chat: { selectedCollections: [key] } } }; setCollectionMeta(key, meta()); });

describe('compatible provider reassignment', () => {
    it('switches KoboldCpp Nomic to llama.cpp Nomic without changing the locator or reindexing, and rolls back', async () => {
        const tested = { status: 'compatible', profile: profile({ apiKey: 'secret' }) };
        const original = structuredClone(locator);
        await reassignEmbeddingConnection(key, locator, tested, { confirmed: true });
        const saved = getCollectionMeta(key);
        expect(saved.storageLocator).toEqual(original);
        expect(saved.embeddingConnection.source).toBe('llamacpp');
        expect(JSON.stringify(saved)).not.toContain('secret');
        expect(resolveCollectionSettings(key, { source: 'openai' }).source).toBe('llamacpp');
        rollbackEmbeddingConnection(key, { confirmed: true });
        expect(getCollectionMeta(key).embeddingConnection).toBeNull();
        expect(resolveCollectionSettings(key, { source: 'openai' }).source).toBe('koboldcpp');
        expect(getCollectionMeta(key).storageLocator).toEqual(original);
    });
    it.each([
        { artifact: 'other' }, { queryPrefix: 'bad' }, { documentTask: 'bad' }, { textCleaning: 'strip-markdown-html' }, { version: 2 },
    ])('refuses same-dimensional incompatible preprocessing/provenance %j', async changes => {
        await expect(reassignEmbeddingConnection(key, locator, { status: 'compatible', profile: profile({ fingerprint: fingerprint(changes) }) }, { confirmed: true })).rejects.toThrow('Rebuild');
        expect(getCollectionMeta(key).embeddingConnection).toBeNull();
    });
    it('missing historical provenance cannot be certified by two currently loaded servers', async () => {
        setCollectionMeta(key, { embedding: { fingerprint: null, probes: null } });
        const fetchImpl = vi.fn().mockResolvedValueOnce(response([probes.document])).mockResolvedValueOnce(response([probes.query]));
        const tested = await testEmbeddingConnection(getCollectionMeta(key), profile(), { fetchImpl });
        expect(tested.status).toBe('unknown');
        await expect(reassignEmbeddingConnection(key, locator, tested, { confirmed: true })).rejects.toThrow('Rebuild');
    });
    it('requires explicit confirmation and checks the fingerprint against historical probes', async () => {
        await expect(reassignEmbeddingConnection(key, locator, { status: 'compatible', profile: profile() })).rejects.toThrow('confirmation');
        await expect(reassignEmbeddingConnection(key, locator, { status: 'compatible', profile: profile({ probes: { ...probes, query: [1, 1] } }) }, { confirmed: true })).rejects.toThrow('Rebuild');
    });
    it('does not export keys or include them in fingerprints', () => {
        expect(JSON.stringify(safeEmbeddingProfile(profile({ apiKey: 'secret', fingerprint: { ...fingerprint(), apiKey: 'secret' } })))).not.toContain('secret');
    });
    it('previews missing provenance as unknown', () => {
        expect(migrationPreview({ embedding: { fingerprint: { dimension: 2 } } }, profile())).toMatchObject({ status: 'unknown', requiresRebuild: true });
    });
});

describe('staged text migration', () => {
    it('preserves metadata and source, stays disabled until confirmed cutover, and restores policy on rollback', async () => {
        const original = structuredClone(getCollectionMeta(key));
        const api = adapters();
        const result = await migrateEmbeddingCollection(request(), api);
        expect(api.backend.insertVectorItems).toHaveBeenCalledWith('new', expect.arrayContaining([expect.objectContaining({ hash: 7, index: 3, metadata: items[0].metadata })]), expect.objectContaining({ source: 'webllm', model: 'synthetic-nomic' }));
        expect(getCollectionMeta(key)).toEqual(original);
        expect(getCollectionMeta(result.targetKey)).toMatchObject({ enabled: false, autoSync: false, groups: original.groups, lockedToChatIds: original.lockedToChatIds, migration: { status: 'ready' } });
        expect(() => cutoverEmbeddingMigration(key, result.targetKey)).toThrow();
        cutoverEmbeddingMigration(key, result.targetKey, { confirmed: true });
        expect(getCollectionMeta(key)).toMatchObject({ enabled: false, autoSync: false });
        expect(getCollectionMeta(result.targetKey)).toMatchObject({ enabled: true, migration: { status: 'active' } });
        expect(extension_settings.vecthare.chatCollectionPolicies.chat.selectedCollections).toEqual([result.targetKey]);
        rollbackEmbeddingMigration(result.targetKey, { confirmed: true });
        expect(getCollectionMeta(key)).toEqual(original);
        expect(extension_settings.vecthare.chatCollectionPolicies.chat.selectedCollections).toEqual([key]);
    });
    it('rejects collisions before writing and never purges another collection', async () => {
        const api = adapters({ assertAbsent: async () => { throw new Error('collision'); } });
        await expect(migrateEmbeddingCollection(request(), api)).rejects.toThrow('collision');
        expect(api.backend.insertVectorItems).not.toHaveBeenCalled(); expect(api.backend.purgeVectorIndex).not.toHaveBeenCalled();
    });
    it('rejects invalid batch size and same source ID without a write', async () => {
        const api = adapters();
        await expect(migrateEmbeddingCollection(request({ targetId: 'old' }), api)).rejects.toThrow('distinct');
        await expect(migrateEmbeddingCollection(request({ batchSize: 0 }), api)).rejects.toThrow('batch');
        expect(api.backend.insertVectorItems).not.toHaveBeenCalled();
    });
    it.each(['write', 'content', 'ranking', 'cancel'])('cleans failed %s target, retains source and supports clean restart', async mode => {
        const controller = new AbortController();
        const api = adapters(); const original = structuredClone(getCollectionMeta(key));
        if (mode === 'write') api.backend.insertVectorItems.mockRejectedValueOnce(new Error('write failed'));
        if (mode === 'content') api.read.mockImplementation(async id => id === 'old' ? structuredClone(items) : []);
        if (mode === 'ranking') api.verifyRanking.mockResolvedValue({ ok: false, reason: 'ranking mismatch' });
        const onProgress = mode === 'cancel' ? () => controller.abort() : undefined;
        await expect(migrateEmbeddingCollection(request({ signal: controller.signal, onProgress }), api)).rejects.toThrow();
        expect(api.backend.purgeVectorIndex).toHaveBeenCalledWith('new', expect.objectContaining({ source: 'webllm' }));
        expect(getCollectionMeta(key)).toEqual(original);
        expect(extension_settings.vecthare.collections['standard:webllm:new']).toBeUndefined();
        expect((await migrateEmbeddingCollection(request({ targetId: 'restart' }), adapters())).status).toBe('ready');
    });
    it('leaves an unremovable partial target disabled and blocks manual enable', async () => {
        const api = adapters(); api.backend.insertVectorItems.mockRejectedValue(new Error('write')); api.backend.purgeVectorIndex.mockRejectedValue(new Error('offline'));
        await expect(migrateEmbeddingCollection(request(), api)).rejects.toThrow('cleanup failed');
        expect(isCollectionEnabled('standard:webllm:new')).toBe(false);
        expect(() => setCollectionMeta('standard:webllm:new', { enabled: true })).toThrow('unverified');
    });
    it('rejects missing text and duplicate stable hashes without writing', async () => {
        for (const snapshot of [[{ hash: 7 }], [...items, ...items]]) {
            const api = adapters({ read: async () => snapshot });
            await expect(migrateEmbeddingCollection(request(), api)).rejects.toThrow();
            expect(api.backend.insertVectorItems).not.toHaveBeenCalled();
        }
    });
    it('pauses source and target writes throughout the migration while source remains readable', async () => {
        const api = adapters({ embed: async () => {
            await expect(collectionMutation('old', { collection_locator: locator }, vi.fn())).rejects.toThrow('paused');
            expect(getCollectionMeta(key).enabled).toBe(true);
            return { embeddings: { key: [1, 0.5] } };
        } });
        await migrateEmbeddingCollection(request(), api);
        const write = vi.fn(); await collectionMutation('old', { collection_locator: locator }, write); expect(write).toHaveBeenCalledOnce();
    });
    it('verifies count, text, identifiers, vector values and temporal/conditional metadata', () => {
        const expected = structuredClone(items);
        expect(verifyMigrationContent(expected, expected).ok).toBe(true);
        for (const actual of [[], [{ ...items[0], hash: 8 }], [{ ...items[0], text: 'changed' }], [{ ...items[0], vector: [0, 1] }], [{ ...items[0], metadata: {} }]]) {
            expect(verifyMigrationContent(expected, actual).ok).toBe(false);
        }
    });
});
