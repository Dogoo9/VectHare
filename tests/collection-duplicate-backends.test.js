import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../core/core-vector-api.js', () => ({ getAdditionalArgs: vi.fn() }));
vi.mock('../core/collection-loader.js', () => ({ registerCollection: vi.fn(), getCollectionRegistry: () => [] }));
vi.mock('../core/lexical-index.js', () => ({ indexLexicalItems: vi.fn() }));
import { extension_settings } from '../../../../extensions.js';
import { resetBackendHealth } from '../backends/backend-manager.js';
import { duplicateCollection } from '../core/collection-duplicate.js';
import { setCollectionMeta, getCollectionMeta, saveChunkMetadata, getChunkMetadata } from '../core/collection-metadata.js';

const backends = ['standard', 'lancedb', 'qdrant'];
const original = Array.from({ length: 503 }, (_, index) => ({ hash: index, index, text: `Chunk ${index}`,
    vector: [1, index / 1000], metadata: { parentHash: 0, keywords: ['memory'], nested: { stable: true } } }));
let storage, requests, pluginAvailable, corrupt;
const normalized = backend => backend === 'vectra' ? 'standard' : backend;
const physicalKey = (backend, id) => `${normalized(backend)}:${id}`;
function source(backend) {
    storage.set(physicalKey(backend, 'old'), structuredClone(original));
    const key = `${backend}:koboldcpp:old`;
    setCollectionMeta(key, { enabled: true, storageLocator: { backend, source: 'koboldcpp', model: 'stored-model', collectionId: 'old' } });
    saveChunkMetadata(0, { enabled: false }, key);
    return key;
}
beforeEach(() => {
    extension_settings.vecthare = { collections: {} };
    resetBackendHealth(); storage = new Map(); requests = []; pluginAvailable = true; corrupt = false;
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : {};
        requests.push({ url, body });
        const json = value => ({ ok: true, status: 200, json: async () => structuredClone(value) });
        if (url === '/api/plugins/similharity/health') return pluginAvailable ? json({ status: 'ok' }) : { ok: false };
        if (url.includes('/backend/init/')) return json({ success: true });
        if (url.includes('/backend/health/')) return json({ healthy: true });
        if (url === '/api/vector/list' && body.collectionId === '__vecthare_health_check__') return json([]);
        if (url.endsWith('/collections')) return json({ success: true, collections: [...storage.keys()].map(key => {
            const [backend, id] = key.split(':'); return { backend, id };
        }) });
        const key = physicalKey(body.backend, body.collectionId);
        if (url.endsWith('/chunks/list')) {
            const items = storage.get(key) || [];
            expect(body.source).toBe('koboldcpp'); expect(body.model).toBe('stored-model');
            return json({ items: items.slice(body.offset, body.offset + body.limit), total: items.length });
        }
        if (url.endsWith('/chunks/insert')) {
            expect(body.items.every(i => Array.isArray(i.vector))).toBe(true);
            expect(body.source).toBe('koboldcpp'); expect(body.model).toBe('stored-model');
            const items = structuredClone(body.items);
            if (corrupt) items[0].vector = [0, 1];
            storage.set(key, [...storage.get(key) || [], ...items]);
            return json({ success: true });
        }
        throw new Error(`Unexpected request (inference must not run): ${url}`);
    }));
});
afterEach(() => vi.unstubAllGlobals());

it.each(backends.flatMap(from => backends.map(to => [from, to])))('copies %s → %s using real adapters, preserving vectors and independent settings', async (from, to) => {
    const key = source(from);
    const before = structuredClone(getCollectionMeta(key));
    const result = await duplicateCollection(key, 'copy', { source: 'openai', vector_backend: 'qdrant' }, { targetBackend: to });
    expect(result).toEqual({ collectionId: 'copy', registryKey: `${to}:koboldcpp:copy`, chunkCount: 503 });
    expect(storage.get(physicalKey(from, 'old'))).toEqual(original);
    const copy = storage.get(physicalKey(to, 'copy'));
    expect(copy.map(c => c.vector)).toEqual(original.map(c => c.vector));
    expect(copy[0]).toMatchObject(original[0]);
    expect(getCollectionMeta(key)).toEqual(before);
    expect(getCollectionMeta(result.registryKey)).toMatchObject({ enabled: false, autoSync: false, importState: { status: 'ready' } });
    saveChunkMetadata(0, { enabled: true }, result.registryKey);
    expect(getChunkMetadata(0, key).enabled).toBe(false);
    expect(requests.filter(r => r.url.endsWith('/chunks/insert'))).toHaveLength(6);
    if (from === 'standard' || to === 'standard') expect(requests.some(r => r.url.endsWith('/backend/init/vectra'))).toBe(true);
});

it('defaults to the source backend, and normalizes Vectra destination aliases', async () => {
    const key = source('lancedb');
    expect((await duplicateCollection(key, 'copy', {})).registryKey).toBe('lancedb:koboldcpp:copy');
    expect((await duplicateCollection(key, 'vectra_copy', {}, { targetBackend: 'vectra' })).registryKey).toBe('standard:koboldcpp:vectra_copy');
});

it('allows the same name on a different backend without overwriting the source', async () => {
    const key = source('qdrant');
    const result = await duplicateCollection(key, 'old', {}, { targetBackend: 'standard' });
    expect(result.registryKey).toBe('standard:koboldcpp:old');
    expect(storage.get('qdrant:old')).toEqual(original);
    expect(storage.get('standard:old')).toHaveLength(503);
    expect(getCollectionMeta(key).enabled).toBe(true);
});

it.each(backends)('rejects an occupied %s destination before writing', async backend => {
    const key = source('qdrant'); storage.set(`${backend}:copy`, []);
    await expect(duplicateCollection(key, 'copy', {}, { targetBackend: backend })).rejects.toThrow('already exists');
    expect(requests.some(r => r.url.endsWith('/chunks/insert'))).toBe(false);
});

it('rejects shared Milvus destinations and Standard without vector-capable storage', async () => {
    const key = source('qdrant');
    await expect(duplicateCollection(key, 'copy', {}, { targetBackend: 'milvus' })).rejects.toThrow('shared storage');
    pluginAvailable = false;
    await expect(duplicateCollection(key, 'copy', {}, { targetBackend: 'standard' })).rejects.toThrow('Similharity is required');
    expect(requests.some(r => r.url.endsWith('/chunks/insert'))).toBe(false);
    expect(storage.get('qdrant:old')).toEqual(original);
});

it('keeps a failed LanceDB copy paused without changing the source', async () => {
    const key = source('standard'); corrupt = true;
    await expect(duplicateCollection(key, 'copy', {}, { targetBackend: 'lancedb' })).rejects.toThrow('vectors differ');
    expect(getCollectionMeta('lancedb:koboldcpp:copy')).toMatchObject({ enabled: false, importState: { status: 'failed' } });
    expect(storage.get('standard:old')).toEqual(original);
});
