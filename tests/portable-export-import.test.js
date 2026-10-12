import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), insert: vi.fn(), purge: vi.fn() }));
vi.mock('../core/core-vector-api.js', () => ({ getSavedHashes: vi.fn(), insertVectorItems: mocks.insert, purgeVectorIndex: mocks.purge }));
vi.mock('../core/collection-loader.js', () => ({ registerCollection: vi.fn(), getCollectionRegistry: () => [] }));
vi.mock('../core/embedding-migration.js', () => ({ readMigrationItems: mocks.read }));
vi.mock('../ui/progress-tracker.js', () => ({ progressTracker: new Proxy({}, { get: () => vi.fn() }) }));
import { extension_settings } from '../../../../extensions.js';
import { setCollectionMeta } from '../core/collection-metadata.js';
import { exportCollection, exportMultipleCollections, importCollection, validateImportData } from '../core/collection-export.js';
import { fingerprint, profile, probes } from './embedding-fixtures.js';

beforeEach(() => { vi.clearAllMocks(); extension_settings.vecthare = { collections: {}, chunk_metadata: {} }; });
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
