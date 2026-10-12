import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { StandardBackend } from '../backends/standard.js';
import { LanceDBBackend } from '../backends/lancedb.js';
import { QdrantBackend } from '../backends/qdrant.js';
import { MilvusBackend } from '../backends/milvus.js';
const settings = { source: 'koboldcpp', collection_locator: { source: 'koboldcpp', model: 'physical-nomic' } };
let fetchMock;
beforeEach(() => { fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, results: [], items: [], total: 0 }) })); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => vi.unstubAllGlobals());
it.each([StandardBackend, LanceDBBackend, QdrantBackend, MilvusBackend])('%s carries physical model and client query vectors to supported plugin APIs', async Backend => {
    const backend = new Backend(); backend.pluginAvailable = true;
    await backend.queryCollection('old', 'private', 5, settings, [1, 0]);
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload).toMatchObject({ source: 'koboldcpp', model: 'physical-nomic', queryVector: [1, 0] });
});
it('native llama.cpp does not silently ignore client vectors and invoke server inference', async () => {
    const backend = new StandardBackend();
    await expect(backend.queryCollection('old', 'private', 5, { source: 'llamacpp' }, [1, 0])).rejects.toThrow('does not accept');
    expect(fetchMock).not.toHaveBeenCalled();
});
it('plugin purge is scoped to the precise storage locator', async () => {
    const backend = new StandardBackend(); backend.pluginAvailable = true;
    await backend.purgeVectorIndex('old', settings);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/plugins/similharity/chunks/purge');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ collectionId: 'old', source: 'koboldcpp', model: 'physical-nomic' });
});
it('precomputed Qdrant documents preserve original text instead of adding keyword strings', async () => {
    await new QdrantBackend().insertVectorItems('old', [{ hash: 7, text: 'key', vector: [1, 0], keywords: ['garden'], metadata: { timestamp: 55 } }], settings);
    const item = JSON.parse(fetchMock.mock.calls[0][1].body).items[0];
    expect(item.text).toBe('key'); expect(item.metadata.timestamp).toBe(55);
});
