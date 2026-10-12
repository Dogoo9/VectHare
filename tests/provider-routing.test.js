import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ backend: {
    pluginAvailable: true, getSavedHashes: vi.fn(async () => [7]), insertVectorItems: vi.fn(),
    deleteVectorItems: vi.fn(), updateChunkMetadata: vi.fn(), updateChunkText: vi.fn(), purgeVectorIndex: vi.fn(),
    queryCollection: vi.fn(async () => ({ hashes: [7], metadata: [{ hash: 7, text: 'key', score: 0.9 }] })),
    queryMultipleCollections: vi.fn(async ids => Object.fromEntries(ids.map(id => [id, { hashes: [7], metadata: [{ hash: 7, text: 'key', score: 0.9 }] }]))),
}, embedLocal: vi.fn(async (texts) => ({ vectors: texts.map(() => [0.5, 1]), model: 'nomic' })) }));
vi.mock('../../../shared.js', () => ({ isWebLlmSupported: () => true }));
vi.mock('../providers/local-embeddings.js', () => ({ embedLocal: mocks.embedLocal }));
vi.mock('../backends/backend-manager.js', () => ({ getBackend: async () => mocks.backend,
    invalidateBackendHealth: vi.fn(), recordQuery: vi.fn(), recordInsert: vi.fn(), recordDelete: vi.fn(), recordError: vi.fn() }));
import { extension_settings } from '../../../../extensions.js';
import { setCollectionMeta } from '../core/collection-metadata.js';
import { getVectorsRequestBody, getSavedHashes, insertVectorItems, deleteVectorItems, updateChunkMetadata, updateChunkText, queryCollection, queryMultipleCollections, purgeVectorIndex } from '../core/core-vector-api.js';
import { indexLexicalItems, purgeAllLexicalIndexes } from '../core/lexical-index.js';
import { collectionStorageKey } from '../core/collection-portability.js';
import { profile, fingerprint, probes } from './embedding-fixtures.js';

const key = 'standard:koboldcpp:old';
const locator = { backend: 'standard', source: 'koboldcpp', model: 'physical-model', collectionId: 'old' };
const globalSettings = { source: 'openai', vector_backend: 'qdrant' };
beforeEach(() => {
    vi.clearAllMocks(); purgeAllLexicalIndexes();
    extension_settings.vecthare = { collections: {} };
    setCollectionMeta(key, { storageLocator: locator, embeddingConnection: profile(), embedding: { fingerprint: fingerprint(), probes, compatibility: 'compatible' } });
    mocks.embedLocal.mockImplementation(async texts => ({ vectors: texts.map(() => [0.5, 1]), model: 'nomic' }));
});
describe('operations after per-collection reassignment', () => {
    it('routes count/hash, query, insert, delete, metadata and purge to the original locator', async () => {
        await getSavedHashes(key, globalSettings);
        await queryCollection(key, 'needle', 5, globalSettings);
        await insertVectorItems(key, [{ hash: 8, text: 'new key' }], globalSettings);
        await deleteVectorItems(key, [8], globalSettings);
        await updateChunkMetadata(key, 7, { enabled: false }, globalSettings);
        await purgeVectorIndex(key, globalSettings);
        const checks = [[mocks.backend.getSavedHashes, 1], [mocks.backend.queryCollection, 3], [mocks.backend.insertVectorItems, 2], [mocks.backend.deleteVectorItems, 2], [mocks.backend.updateChunkMetadata, 3], [mocks.backend.purgeVectorIndex, 1]];
        for (const [fn, index] of checks) {
            expect(fn.mock.calls[0][0]).toBe('old');
            expect(fn.mock.calls[0][index]).toMatchObject({ vector_backend: 'standard', source: 'koboldcpp', model: 'physical-model' });
        }
        expect(mocks.embedLocal.mock.calls[0][1].source).toBe('llamacpp');
        expect(mocks.embedLocal.mock.calls[0][2].mode).toBe('query');
        expect(mocks.embedLocal.mock.calls[1][2].mode).toBe('document');
    });
    it('fixes full metadata hashes lookup using physical source/model/backend', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, items: [{ metadata: { hash: 7, text: 'key' } }] }) }));
        vi.stubGlobal('fetch', fetchMock);
        expect((await getSavedHashes(key, globalSettings, true)).metadata[0].hash).toBe(7);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ backend: 'vectra', source: 'koboldcpp', model: 'physical-model', collectionId: 'old' });
        vi.unstubAllGlobals();
    });
    it('does not reuse a query vector across mixed embedding profiles', async () => {
        setCollectionMeta('standard:koboldcpp:second', { storageLocator: { ...locator, collectionId: 'second' }, embeddingConnection: profile({ model: 'other', fingerprint: fingerprint({ artifact: 'other' }) }), embedding: { fingerprint: fingerprint({ artifact: 'other' }), probes, compatibility: 'compatible' } });
        const result = await queryMultipleCollections([key, 'standard:koboldcpp:second'], 'needle', 5, 0, globalSettings);
        expect(Object.keys(result)).toEqual([key, 'standard:koboldcpp:second']);
        expect(mocks.embedLocal).toHaveBeenCalledTimes(2);
        expect(mocks.backend.queryMultipleCollections.mock.calls.map(c => c[0])).toEqual([['old'], ['second']]);
        expect(mocks.embedLocal.mock.calls.map(c => c[1].model)).toEqual(['synthetic-nomic', 'other']);
    });
    it('shares a vector only for matching profiles while preserving each collection ID', async () => {
        setCollectionMeta('standard:koboldcpp:second', { storageLocator: { ...locator, collectionId: 'second' }, embeddingConnection: profile(), embedding: { fingerprint: fingerprint(), probes, compatibility: 'compatible' } });
        await queryMultipleCollections([key, 'standard:koboldcpp:second'], 'needle', 5, 0, globalSettings);
        expect(mocks.embedLocal).toHaveBeenCalledOnce();
        expect(mocks.backend.queryMultipleCollections.mock.calls[0][0]).toEqual(['old', 'second']);
    });
    it('does not fall back to remote/global inference after a local error', async () => {
        mocks.embedLocal.mockRejectedValueOnce(new Error('local offline'));
        await expect(queryCollection(key, 'private', 5, globalSettings)).rejects.toThrow('local offline');
        expect(mocks.backend.queryCollection).not.toHaveBeenCalled();
    });
    it('blocks edits needing unsupported atomic vector updates before touching text', async () => {
        await expect(updateChunkText(key, 7, 'edited', globalSettings)).rejects.toThrow('atomic');
        expect(mocks.backend.updateChunkText).not.toHaveBeenCalled(); expect(mocks.backend.insertVectorItems).not.toHaveBeenCalled();
    });
    it('uses complete lexical fallback without dense inference and refuses missing coverage', async () => {
        setCollectionMeta(key, { retrievalMode: 'lexical_only' });
        await expect(queryCollection(key, 'key', 5, globalSettings)).rejects.toThrow('incomplete');
        indexLexicalItems(collectionStorageKey('old', { collection_locator: locator }), [{ hash: 7, text: 'key' }]);
        const result = await queryCollection(key, 'key', 5, globalSettings);
        expect(result.hashes).toEqual([7]); expect(result.metadata[0].retrievalMode).toBe('lexical-only');
        expect(mocks.embedLocal).not.toHaveBeenCalled(); expect(mocks.backend.queryCollection).not.toHaveBeenCalled();
    });
    it('client-side hybrid keeps physical namespace and precomputed vector', async () => {
        await queryCollection(key, 'key', 5, { ...globalSettings, hybrid_search_enabled: true });
        expect(mocks.backend.queryCollection.mock.calls[0][3]).toMatchObject({ source: 'koboldcpp', model: 'physical-model' });
        expect(mocks.backend.queryCollection.mock.calls[0][4]).toEqual([0.5, 1]);
    });
});

it('server-generated inserts and queries carry the selected alternate llama.cpp URL', async () => {
    const settings = { source: 'llamacpp', vector_backend: 'qdrant', use_alt_endpoint: true, alt_endpoint_url: 'http://127.0.0.1:8099' };
    await insertVectorItems('new', [{ hash: 8, text: 'synthetic' }], settings);
    expect(mocks.backend.insertVectorItems.mock.calls[0][2].inference_request_args).toMatchObject({ apiUrl: settings.alt_endpoint_url });
    await queryCollection('new', 'synthetic', 5, settings);
    expect(mocks.backend.queryCollection.mock.calls[0][3].inference_request_args).toMatchObject({ apiUrl: settings.alt_endpoint_url });
});
it('missing llama.cpp URL fails before any insert or query', async () => {
    await expect(insertVectorItems('new', [{ hash: 8, text: 'synthetic' }], { source: 'llamacpp' })).rejects.toThrow('Configure');
    expect(mocks.backend.insertVectorItems).not.toHaveBeenCalled();
});

it('client profiles use their own endpoint without requiring a global llama.cpp URL', async () => {
    await queryCollection('new', 'synthetic', 5, { source: 'llamacpp', local_embedding_profile: profile(), vector_backend: 'qdrant' });
    expect(mocks.embedLocal.mock.calls[0][1].endpoint).toBe('http://localhost:8080');
    expect(mocks.backend.queryCollection.mock.calls[0][4]).toEqual([0.5, 1]);
});
