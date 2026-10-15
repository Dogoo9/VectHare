import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ backend: null }));
vi.mock('../../../shared.js', () => ({ isWebLlmSupported: () => true }));
vi.mock('../../../../textgen-settings.js', () => ({
    textgen_types: { LLAMACPP: 'llamacpp' },
    textgenerationwebui_settings: { server_urls: {} },
}));
vi.mock('../backends/backend-manager.js', () => ({
    getBackend: async () => mocks.backend,
    invalidateBackendHealth: vi.fn(), recordQuery: vi.fn(), recordInsert: vi.fn(),
    recordDelete: vi.fn(), recordError: vi.fn(),
}));

import { extension_settings } from '../../../../extensions.js';
import { QdrantBackend } from '../backends/qdrant.js';
import { queryCollection, queryMultipleCollections } from '../core/core-vector-api.js';
import { collectionStorageKey } from '../core/collection-portability.js';
import { indexLexicalItems, purgeAllLexicalIndexes } from '../core/lexical-index.js';

const id = 'qdrant:llamacpp:vecthare_import_example';
const endpoint = 'http://127.0.0.1:5001';
const settings = {
    source: 'llamacpp', vector_backend: 'qdrant', use_alt_endpoint: true,
    alt_endpoint_url: endpoint, hybrid_search_enabled: true,
};
const item = { hash: 7, text: 'The brass key opens the garden gate.', score: 0.9 };
let requests;
let nativeUnavailable;
let inferenceUnavailable;

beforeEach(() => {
    extension_settings.vecthare = { collections: {} };
    purgeAllLexicalIndexes();
    mocks.backend = new QdrantBackend();
    requests = [];
    nativeUnavailable = false;
    inferenceUnavailable = false;
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        const body = JSON.parse(options.body);
        requests.push({ url, body });
        if (nativeUnavailable && url.endsWith('/hybrid-query')) {
            return { ok: false, status: 404 };
        }
        // Model the plugin's default of localhost:8080 when apiUrl is omitted.
        if (inferenceUnavailable || body.apiUrl !== endpoint) {
            return { ok: false, status: 500, statusText: 'Internal Server Error',
                text: async () => 'ECONNREFUSED at the embedding endpoint' };
        }
        return { ok: true, json: async () => ({ results: [item] }) };
    }));
});
afterEach(() => { purgeAllLexicalIndexes(); vi.unstubAllGlobals(); });

async function search(multi, native) {
    const config = { ...settings, hybrid_fusion_method: native ? 'rrf' : 'heuristic_weighted' };
    if (multi) return (await queryMultipleCollections([id], 'garden key', 5, 0, config))[id];
    return queryCollection(id, 'garden key', 5, config);
}

describe('llama.cpp endpoint routing through Qdrant hybrid search', () => {
    it.each([
        { multi: false, native: false }, { multi: true, native: false },
        { multi: false, native: true }, { multi: true, native: true },
    ])('uses the configured endpoint with no browser lexical index: %j', async ({ multi, native }) => {
        const result = await search(multi, native);
        expect(result.hashes).toEqual([7]);
        expect(requests).toHaveLength(1);
        expect(requests[0].url).toBe(`/api/plugins/similharity/chunks/${native ? 'hybrid-query' : 'query'}`);
        expect(requests[0].body).toMatchObject({
            apiUrl: endpoint, source: 'llamacpp', collectionId: 'vecthare_import_example',
        });
    });

    it('retrieves on a fresh phone just as on a desktop with a populated lexical index', async () => {
        indexLexicalItems(collectionStorageKey(id, settings), [item]);
        const desktop = await search(true, true);
        purgeAllLexicalIndexes();
        const phone = await search(true, true);
        expect(desktop.hashes).toEqual([7]);
        expect(phone.hashes).toEqual([7]);
        expect(requests.every(request => request.body.apiUrl === endpoint)).toBe(true);
    });

    it('keeps the endpoint when native hybrid search falls back to vector search', async () => {
        nativeUnavailable = true;
        const result = await search(true, true);
        expect(result.hashes).toEqual([7]);
        expect(requests.map(request => request.url)).toEqual([
            '/api/plugins/similharity/chunks/hybrid-query', '/api/plugins/similharity/chunks/query',
        ]);
        expect(requests.every(request => request.body.apiUrl === endpoint)).toBe(true);
    });

    it('reports an inference failure on a fresh browser instead of an empty successful search', async () => {
        inferenceUnavailable = true;
        await expect(search(false, false)).rejects.toThrow('ECONNREFUSED');
        const result = await search(true, false);
        expect(result.hashes).toEqual([]);
        expect(result.error).toContain('ECONNREFUSED');
    });

    it('retains lexical fallback for browsers that have matching local chunks', async () => {
        inferenceUnavailable = true;
        indexLexicalItems(collectionStorageKey(id, settings), [item]);
        expect((await search(true, false)).hashes).toEqual([7]);
    });
});
