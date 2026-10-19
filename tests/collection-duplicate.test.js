import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ backend: null, sourceBackend: null }));
vi.mock('../backends/backend-manager.js', () => ({ getBackend: vi.fn(async settings => settings.vector_backend === 'standard' ? state.sourceBackend : state.backend) }));
vi.mock('../core/core-vector-api.js', () => ({ getAdditionalArgs: vi.fn() }));
vi.mock('../core/collection-loader.js', () => ({ registerCollection: vi.fn(), getCollectionRegistry: () => [] }));
vi.mock('../core/lexical-index.js', () => ({ indexLexicalItems: vi.fn() }));
import { extension_settings } from '../../../../extensions.js';
import { QdrantBackend } from '../backends/qdrant.js';
import { StandardBackend } from '../backends/standard.js';
import { getBackend } from '../backends/backend-manager.js';
import { duplicateCollectionToQdrant } from '../core/collection-duplicate.js';
import { getCollectionMeta, setCollectionMeta, setCollectionEnabled } from '../core/collection-metadata.js';
import { collectionMutation } from '../core/collection-runtime.js';

const key = 'qdrant:koboldcpp:old';
const locator = { backend: 'qdrant', source: 'koboldcpp', model: 'stored-model', collectionId: 'old' };
let original, collections, requests, corrupt;
beforeEach(() => {
    extension_settings.vecthare = { collections: {}, vecthare_collection_registry: [] };
    state.backend = new QdrantBackend(); corrupt = false;
    state.sourceBackend = new StandardBackend(); state.sourceBackend.pluginAvailable = true;
    original = Array.from({ length: 503 }, (_, index) => ({ hash: index, index, text: `Memory ${index}`, vector: [1, index / 1000], metadata: { timestamp: index, keywords: ['memory'], group: 'g' } }));
    collections = new Map([['old', structuredClone(original)]]);
    requests = [];
    setCollectionMeta(key, { enabled: true, autoSync: true, storageLocator: locator, groups: [{ id: 'g' }], lockedToChatIds: ['chat'], embedding: { compatibility: 'unknown' } });
    vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : {};
        requests.push({ url, body });
        const json = value => ({ ok: true, json: async () => value });
        if (url.endsWith('/collections')) return json({ success: true, collections: [...collections.keys()].map(id => ({ backend: 'qdrant', id })) });
        if (url.endsWith('/chunks/list')) {
            const items = collections.get(body.collectionId) || [];
            return json({ items: items.slice(body.offset, body.offset + body.limit), total: items.length });
        }
        if (url.endsWith('/chunks/insert')) {
            expect(body.items.every(i => i.vector)).toBe(true);
            expect(body.model).toBe('stored-model');
            expect(body.source).toBe('koboldcpp');
            expect(getCollectionMeta('qdrant:koboldcpp:copy')).toMatchObject({ enabled: false, autoSync: false });
            const batch = structuredClone(body.items);
            if (corrupt) batch[0].vector = [0, 1];
            collections.set(body.collectionId, [...collections.get(body.collectionId) || [], ...batch]);
            return json({ success: true });
        }
        throw new Error(`Unexpected request ${url}`);
    }));
});
afterEach(() => vi.unstubAllGlobals());

it('copies every page of vectors and metadata to the exact user name without calling inference or mutating the source', async () => {
    const before = structuredClone(getCollectionMeta(key));
    const result = await duplicateCollectionToQdrant(key, ' copy ', { source: 'openai', openai_model: 'wrong' });
    expect(result).toEqual({ collectionId: 'copy', registryKey: 'qdrant:koboldcpp:copy', chunkCount: 503 });
    expect(collections.get('old')).toEqual(original);
    expect(getCollectionMeta(key)).toEqual(before);
    expect(collections.get('copy').map(i => i.vector)).toEqual(original.map(i => i.vector));
    expect(collections.get('copy')[0]).toMatchObject({ hash: 0, index: 0, text: 'Memory 0', metadata: original[0].metadata });
    expect(getCollectionMeta(result.registryKey)).toMatchObject({ enabled: false, autoSync: false, displayName: 'copy', groups: [{ id: 'g' }], lockedToChatIds: ['chat'], storageLocator: { ...locator, collectionId: 'copy' }, importState: { status: 'ready' } });
    expect(requests.filter(r => r.url.endsWith('/chunks/insert'))).toHaveLength(6);
    setCollectionEnabled(result.registryKey, true);
    expect(getCollectionMeta(result.registryKey).enabled).toBe(true);
});

it.each(['', 'old', '../bad', 'bad:name'])('rejects an invalid or source name %j before writing', async name => {
    await expect(duplicateCollectionToQdrant(key, name, {})).rejects.toThrow();
    expect(requests.some(r => r.url.endsWith('/chunks/insert'))).toBe(false);
});

it.each(['copy', 'qdrant:copy', 'qdrant:openai:copy'])('refuses a collision even with an empty disk index %s', async id => {
    collections.set(id, []);
    await expect(duplicateCollectionToQdrant(key, 'copy', {})).rejects.toThrow('already exists');
    expect(requests.some(r => r.url.endsWith('/chunks/insert'))).toBe(false);
});

it('refuses unverified discovery, shared mode, missing vectors and empty sources before writing', async () => {
    await expect(duplicateCollectionToQdrant(key, 'copy', { qdrant_multitenancy: true })).rejects.toThrow('multitenancy');
    fetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(duplicateCollectionToQdrant(key, 'copy', {})).rejects.toThrow('discovery');
    collections.set('old', [{ ...original[0], vector: null }]);
    await expect(duplicateCollectionToQdrant(key, 'copy', {})).rejects.toThrow('stored vector');
    collections.set('old', []);
    await expect(duplicateCollectionToQdrant(key, 'copy', {})).rejects.toThrow('empty');
    expect(collections.has('copy')).toBe(false);
});

it('keeps a corrupt or failed target disabled and releases the source lock', async () => {
    corrupt = true;
    await expect(duplicateCollectionToQdrant(key, 'copy', {})).rejects.toThrow('vectors differ');
    expect(getCollectionMeta('qdrant:koboldcpp:copy')).toMatchObject({ enabled: false, importState: { status: 'failed' } });
    expect(() => setCollectionEnabled('qdrant:koboldcpp:copy', true)).toThrow('unverified');
    await expect(collectionMutation('old', { collection_locator: locator }, async () => 'unlocked')).resolves.toBe('unlocked');
    expect(collections.get('old')).toEqual(original);
});

it('copies from Standard storage to Qdrant and initializes the target with the correct physical routing', async () => {
    const sourceKey = 'standard:koboldcpp:old';
    setCollectionMeta(sourceKey, { storageLocator: { ...locator, backend: 'standard' } });
    await duplicateCollectionToQdrant(sourceKey, 'copy', { vector_backend: 'standard' });
    expect(requests.some(r => r.url.endsWith('/chunks/list') && r.body.backend === 'vectra' && r.body.collectionId === 'old')).toBe(true);
    expect(requests.filter(r => r.url.endsWith('/chunks/insert')).every(r => r.body.backend === 'qdrant')).toBe(true);
    expect(getBackend).toHaveBeenCalledWith(expect.objectContaining({ vector_backend: 'qdrant', _storageReadOnly: false }));
});

it('leaves partial writes paused after a backend failure and does not retry ambiguous writes', async () => {
    const implementation = fetch.getMockImplementation();
    let writes = 0;
    fetch.mockImplementation(async (url, options) => {
        if (url.endsWith('/chunks/insert') && ++writes === 2) throw new Error('connection lost');
        return implementation(url, options);
    });
    await expect(duplicateCollectionToQdrant(key, 'copy', {})).rejects.toThrow('connection lost');
    expect(writes).toBe(2);
    expect(collections.get('copy')).toHaveLength(100);
    expect(getCollectionMeta('qdrant:koboldcpp:copy')).toMatchObject({ enabled: false, importState: { status: 'failed' } });
    expect(collections.get('old')).toEqual(original);
});

it('blocks simultaneous duplicate names and source edits while taking a consistent snapshot', async () => {
    const implementation = fetch.getMockImplementation();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    fetch.mockImplementation(async (url, options) => {
        if (url.endsWith('/collections')) await gate;
        return implementation(url, options);
    });
    const first = duplicateCollectionToQdrant(key, 'copy', {});
    try {
        await expect(duplicateCollectionToQdrant(key, 'copy', {})).rejects.toThrow('already being created');
        await expect(collectionMutation('old', { collection_locator: locator }, async () => {})).rejects.toThrow('paused');
    } finally { release(); }
    await first;
    expect(collections.get('copy')).toHaveLength(503);
});
