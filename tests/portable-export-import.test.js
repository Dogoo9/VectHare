import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), insert: vi.fn(), purge: vi.fn(), hashes: vi.fn(async () => [0]) }));
vi.mock('../core/core-vector-api.js', () => ({ getSavedHashes: mocks.hashes, insertVectorItems: mocks.insert, purgeVectorIndex: mocks.purge }));
vi.mock('../core/collection-loader.js', () => ({ registerCollection: vi.fn(), getCollectionRegistry: () => [] }));
vi.mock('../core/embedding-migration.js', () => ({ readMigrationItems: mocks.read }));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: new Proxy({}, { get: () => vi.fn() }) }));
import { extension_settings } from '../../../../extensions.js';
import { setCollectionMeta, getCollectionMeta, setCollectionEnabled } from '../core/collection-metadata.js';
import { exportCollection, exportMultipleCollections, importCollection, importMultipleCollections, validateImportData } from '../core/collection-export.js';
import { fingerprint, profile, probes } from './embedding-fixtures.js';

beforeEach(() => { vi.clearAllMocks(); mocks.insert.mockReset(); mocks.hashes.mockResolvedValue([0]); extension_settings.vecthare = { collections: {}, chunk_metadata: {} }; vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ success: true, collections: [] }) }))); });
afterEach(() => vi.unstubAllGlobals());
it('exports frozen routing, complete text/temporal metadata, stable zero hashes and fingerprint without endpoint credentials', async () => {
    const locator = { backend: 'standard', source: 'koboldcpp', model: 'physical', collectionId: 'old' };
    setCollectionMeta('standard:koboldcpp:old', { storageLocator: locator, embeddingConnection: profile({ apiKey: 'secret' }), embedding: { fingerprint: fingerprint(), probes }, lockedToChatIds: ['chat-1'], groups: [{ id: 'g' }] });
    mocks.read.mockResolvedValue([{ hash: 0, text: 'key', index: 2, vector: [1, 0.5], metadata: { hash: 0, text: 'key', timestamp: 55, group: 'g' } }]);
    const exported = await exportCollection('standard:koboldcpp:old', { source: 'openai' });
    expect(mocks.read.mock.calls[0][0]).toBe('old');
    expect(mocks.read.mock.calls[0][1]).toMatchObject({ source: 'koboldcpp', model: 'physical' });
    expect(exported.storageLocator).toEqual(locator); expect(exported.chunks[0].hash).toBe(0);
    expect(exported.chunks[0].metadata.timestamp).toBe(55);
    expect(exported.settings.lockedToChatIds).toEqual(['chat-1']);
    expect(exported.embedding.fingerprint).toEqual(fingerprint());
    expect(JSON.stringify(exported)).not.toContain('secret');
    expect(JSON.stringify(exported)).not.toContain('localhost');
    expect((await exportMultipleCollections(['standard:koboldcpp:old'], {})).collections[0].chunks[0].vector).toEqual([1, 0.5]);
});
it('old imports with only names and dimensions re-embed while preserving stable IDs', async () => {
    const old = { version: '1.0.0', collection: { id: 'imported' }, embedding: { source: 'koboldcpp', model: 'nomic', dimension: 2 },
        chunks: [{ hash: 0, text: 'key', index: 4, vector: [1, 0.5], metadata: { timestamp: 55 } }] };
    expect(validateImportData(old, { source: 'koboldcpp', embedding_fingerprint: fingerprint() })).toMatchObject({ compatible: false, compatibilityStatus: 'unknown' });
    const result = await importCollection(old, { source: 'koboldcpp', embedding_fingerprint: fingerprint() });
    expect(result.usedVectors).toBe(false);
    expect(mocks.insert.mock.calls[0][1][0]).toMatchObject({ hash: 0, text: 'key', index: 4, metadata: { timestamp: 55 } });
    expect(mocks.insert.mock.calls[0][1][0].vector).toBeUndefined();
});
it('matching fingerprints without saved probes do not reuse exported vectors', () => {
    const data = { version: '1.0.0', collection: { id: 'x' }, embedding: { fingerprint: fingerprint() }, chunks: [{ hash: 1, text: 'key', vector: [1, 0.5] }] };
    expect(validateImportData(data, { source: 'llamacpp', embedding_fingerprint: fingerprint() }).compatible).toBe(false);
});
it('refuses missing text before any write rather than dropping memory from old imports', async () => {
    await expect(importCollection({ collection: { id: 'x' }, chunks: [{ hash: 1, vector: [1, 0] }] }, {})).rejects.toThrow('recoverable text');
    expect(mocks.insert).not.toHaveBeenCalled();
});

const backup = () => ({ version: '1.0.0', collection: { id: 'original', name: 'Original' }, chunks: [{ hash: 0, text: 'recoverable', index: 1 }] });
it('rejects overwrite before purging or embedding for single and multi-imports', async () => {
    await expect(importCollection(backup(), {}, { overwrite: true })).rejects.toThrow('cannot overwrite');
    const result = await importMultipleCollections({ collections: [backup()] }, {}, { overwrite: true });
    expect(result.failed).toBe(1);
    expect(mocks.purge).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
});
it('refuses an existing metadata destination without modifying its collection settings', async () => {
    setCollectionMeta('qdrant:koboldcpp:original', { enabled: true, autoSync: true });
    const before = structuredClone(extension_settings.vecthare.collections);
    await expect(importCollection(backup(), { vector_backend: 'qdrant', source: 'llamacpp' })).rejects.toThrow('already exists');
    expect(extension_settings.vecthare.collections).toEqual(before); expect(mocks.purge).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
});
it('checks disk collisions, including empty collections with backend-prefixed IDs', async () => {
    fetch.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, collections: [{ id: 'qdrant:original', backend: 'qdrant' }] }) });
    await expect(importCollection(backup(), { vector_backend: 'qdrant' })).rejects.toThrow('already exists on disk');
    expect(mocks.purge).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
});
it('keeps a failed partial copy disabled while retaining the original', async () => {
    setCollectionMeta('qdrant:koboldcpp:original', { enabled: true, autoSync: true });
    const original = structuredClone(getCollectionMeta('qdrant:koboldcpp:original'));
    mocks.insert.mockImplementation(async () => {
        expect(getCollectionMeta('qdrant:llamacpp:copy').enabled).toBe(false);
        throw new Error('llama endpoint offline');
    });
    await expect(importCollection(backup(), { vector_backend: 'qdrant', source: 'llamacpp' }, { collectionId: 'copy' })).rejects.toThrow('endpoint offline');
    expect(getCollectionMeta('qdrant:koboldcpp:original')).toEqual(original);
    expect(getCollectionMeta('qdrant:llamacpp:copy')).toMatchObject({ enabled: false, autoSync: false, importState: { status: 'failed' } });
    expect(() => setCollectionEnabled('qdrant:llamacpp:copy', true)).toThrow('unverified');
    expect(mocks.purge).not.toHaveBeenCalled();
});
it('verifies the copy but leaves activation to the user', async () => {
    const result = await importCollection(backup(), { vector_backend: 'qdrant', source: 'llamacpp' }, { collectionId: 'copy' });
    expect(result).toMatchObject({ success: true, enabled: false, registryKey: 'qdrant:llamacpp:copy' });
    expect(getCollectionMeta(result.registryKey)).toMatchObject({ enabled: false, importState: { status: 'ready' } });
    setCollectionEnabled(result.registryKey, true); expect(getCollectionMeta(result.registryKey).enabled).toBe(true);
    expect(mocks.purge).not.toHaveBeenCalled();
});
it('leaves a copy disabled if its final count cannot be verified', async () => {
    mocks.hashes.mockResolvedValue([]);
    await expect(importCollection(backup(), {}, { collectionId: 'copy' })).rejects.toThrow('could not be verified');
    expect(getCollectionMeta('standard:transformers:copy').enabled).toBe(false);
});

it.each([{ vector_backend: 'milvus' }, { vector_backend: 'qdrant', qdrant_multitenancy: true }])('rejects a shared physical import index before writes', async settings => {
    await expect(importCollection(backup(), settings, { collectionId: 'copy' })).rejects.toThrow('separate physical index');
    expect(mocks.purge).not.toHaveBeenCalled(); expect(mocks.insert).not.toHaveBeenCalled();
});

it('refuses a duplicate stored hash list even if its count matches the input', async () => {
    const data = backup(); data.chunks.push({ hash: 1, text: 'second', index: 2 });
    mocks.hashes.mockResolvedValue([0, 0]);
    await expect(importCollection(data, {}, { collectionId: 'copy' })).rejects.toThrow('could not be verified');
    expect(getCollectionMeta('standard:transformers:copy').enabled).toBe(false);
});
