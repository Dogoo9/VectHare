import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ backend: null }));
vi.mock('../../../shared.js', () => ({ isWebLlmSupported: () => true }));
vi.mock('../backends/backend-manager.js', () => ({ getBackend: async () => state.backend,
    invalidateBackendHealth: vi.fn(), recordQuery: vi.fn(), recordInsert: vi.fn(), recordDelete: vi.fn(), recordError: vi.fn() }));
import { extension_settings } from '../../../../extensions.js';
import { StandardBackend } from '../backends/standard.js';
import { setCollectionMeta, getCollectionMeta } from '../core/collection-metadata.js';
import { migrateEmbeddingCollection } from '../core/embedding-migration.js';
import { queryCollection } from '../core/core-vector-api.js';
import { profile, probes, response } from './embedding-fixtures.js';
import { SYNTHETIC_PROBES } from '../providers/local-embeddings.js';

beforeEach(() => { extension_settings.vecthare = { collections: {}, vecthare_collection_registry: [] }; state.backend = new StandardBackend(); state.backend.pluginAvailable = true; });

it('exercises local inference, plugin storage, pagination, count/content/vector/ranking verification and a retained source using synthetic data', async () => {
    const key = 'standard:koboldcpp:old';
    const locator = { backend: 'standard', source: 'koboldcpp', model: '', collectionId: 'old' };
    const original = [{ hash: 7, text: 'key', index: 0, vector: [1, 0], metadata: { hash: 7, text: 'key', index: 0, timestamp: 10, conditions: { enabled: true } } },
        { hash: 8, text: 'flower', index: 1, vector: [0, 1], metadata: { hash: 8, text: 'flower', index: 1, group: 'garden' } }];
    const collections = new Map([['koboldcpp::old', structuredClone(original)]]);
    const json = data => ({ ok: true, json: async () => data });
    const fetchMock = vi.fn(async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : {};
        if (String(url).startsWith('http://localhost:8080/')) {
            return response(body.input.map(text => text.includes(SYNTHETIC_PROBES.document) ? probes.document : text.includes(SYNTHETIC_PROBES.query) ? probes.query : text.endsWith('key') ? [1, 0] : [0, 1]));
        }
        const id = `${body.source}:${body.model || ''}:${body.collectionId}`;
        if (url === '/api/plugins/similharity/collections') return json({ success: true, collections: [{ id: 'old', source: 'koboldcpp' }] });
        if (url === '/api/vector/list') return json((collections.get(id) || []).map(i => i.hash));
        if (url === '/api/plugins/similharity/chunks/list') {
            const items = collections.get(id) || [];
            return json({ success: true, items: items.slice(body.offset, body.offset + body.limit), total: items.length });
        }
        if (url === '/api/plugins/similharity/chunks/insert') {
            expect(body.items.every(i => i.vector)).toBe(true);
            collections.set(id, [...(collections.get(id) || []), ...body.items.map(i => ({ ...i, metadata: { ...i.metadata, hash: i.hash, text: i.text, index: i.index } }))]);
            return json({ success: true });
        }
        if (url === '/api/plugins/similharity/chunks/query') {
            expect(body.queryVector).toBeDefined();
            const dot = vector => vector.reduce((sum, n, i) => sum + n * body.queryVector[i], 0);
            const results = (collections.get(id) || []).map(i => ({ ...i, score: dot(i.vector) })).sort((a, b) => b.score - a.score).slice(0, body.topK);
            return json({ success: true, results });
        }
        throw new Error(`Unexpected synthetic request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
        setCollectionMeta(key, { storageLocator: locator, enabled: true, autoSync: true });
        const result = await migrateEmbeddingCollection({ key, locator, settings: {}, targetId: 'new', candidate: profile(), confirmed: true, batchSize: 1 });
        expect(result.verification).toMatchObject({ ok: true, count: 2, content: true, ranking: true });
        expect(collections.get('koboldcpp::old')).toEqual(original);
        expect(getCollectionMeta(key)).toMatchObject({ enabled: true, autoSync: true, storageLocator: locator });
        expect(getCollectionMeta(result.targetKey).enabled).toBe(false);
        const query = await queryCollection(result.targetKey, 'key', 1, { source: 'openai' });
        expect(query.hashes).toEqual([7]);
        expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/text'))).toBe(false);
    } finally { vi.unstubAllGlobals(); }
});
