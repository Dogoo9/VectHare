import assert from 'node:assert/strict';
import test from 'node:test';

import { QdrantBackend } from '../qdrant-backend.js';

test('point IDs are stable and isolated by tenant', () => {
    const backend = new QdrantBackend();
    const alice = { type: 'chat', sourceId: 'alice', embeddingSource: 'transformers' };
    const bob = { ...alice, sourceId: 'bob' };

    assert.equal(backend._getPointId(123, alice), backend._getPointId(123, alice));
    assert.notEqual(backend._getPointId(123, alice), backend._getPointId(123, bob));
    assert.match(backend._getPointId(123, alice), /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
});

test('insert uses tenant-specific IDs while preserving VectHare hashes', async () => {
    const backend = new QdrantBackend();
    backend.baseUrl = 'http://qdrant.test';
    const requests = [];
    backend._request = async (method, endpoint, body) => {
        requests.push({ method, endpoint, body });
        if (endpoint === '/collections') return { result: { collections: [{ name: 'vecthare_main' }] } };
        if (method === 'GET') return { result: { config: { params: { vectors: { size: 2 } } } } };
        return { result: {} };
    };

    const tenant = { type: 'chat', sourceId: 'chat-1', embeddingSource: 'transformers' };
    await backend.insertVectors('vecthare_main', [{ hash: 42, text: 'hello', vector: [0.1, 0.2] }], tenant);

    const upsert = requests.find(request => request.endpoint.includes('/points?wait=true'));
    assert.equal(upsert.body.points[0].hash, undefined);
    assert.equal(upsert.body.points[0].payload.hash, 42);
    assert.equal(upsert.body.points[0].id, backend._getPointId(42, tenant));
});

test('delete scopes matching hashes to the requested tenant', async () => {
    const backend = new QdrantBackend();
    backend.baseUrl = 'http://qdrant.test';
    let deletion;
    backend._request = async (method, endpoint, body) => {
        deletion = { method, endpoint, body };
        return { result: {} };
    };

    await backend.deleteVectors('vecthare_main', ['42'], {
        type: 'chat',
        sourceId: 'chat-1',
        embeddingSource: 'transformers',
    });

    assert.equal(deletion.method, 'POST');
    assert.deepEqual(deletion.body, {
        filter: {
            must: [
                { key: 'hash', match: { any: [42] } },
                { key: 'type', match: { value: 'chat' } },
                { key: 'sourceId', match: { value: 'chat-1' } },
                { key: 'embeddingSource', match: { value: 'transformers' } },
            ],
        },
    });
});

test('legacy point migration previews and rewrites old IDs', async () => {
    const backend = new QdrantBackend();
    backend.baseUrl = 'http://qdrant.test';
    const writes = [];
    backend._request = async (method, endpoint, body) => {
        if (method === 'GET') return { result: { collections: [{ name: 'vecthare_main' }] } };
        if (endpoint.endsWith('/scroll')) {
            return {
                result: {
                    points: [{
                        id: 42,
                        vector: [0.1, 0.2],
                        payload: { hash: 42, type: 'chat', sourceId: 'chat-1', embeddingSource: 'transformers' },
                    }],
                    next_page_offset: null,
                },
            };
        }
        writes.push({ method, endpoint, body });
        return { result: {} };
    };

    assert.deepEqual(await backend.migrateLegacyPointIds('vecthare_main'), {
        collection: 'vecthare_main', scanned: 1, migrated: 1, dryRun: true,
    });
    assert.equal(writes.length, 0);

    const result = await backend.migrateLegacyPointIds('vecthare_main', { dryRun: false });
    assert.equal(result.migrated, 1);
    assert.equal(writes.length, 2);
    assert.match(writes[0].body.points[0].id, /^[a-f0-9-]{36}$/);
    assert.deepEqual(writes[1].body, { points: [42] });
});

test('Qdrant read failures are not disguised as empty collections', async () => {
    const backend = new QdrantBackend();
    backend.baseUrl = 'http://qdrant.test';
    backend._request = async () => { throw new Error('connection refused'); };

    await assert.rejects(
        backend.listItems('vecthare_main'),
        /connection refused/,
    );
    await assert.rejects(
        backend.queryCollection('vecthare_main', [0.1, 0.2]),
        /connection refused/,
    );
});
