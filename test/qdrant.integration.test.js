import assert from 'node:assert/strict';
import test from 'node:test';

import { QdrantBackend } from '../qdrant-backend.js';

const qdrantUrl = process.env.QDRANT_TEST_URL;

test('Qdrant integration: collection lifecycle and tenant isolation', { skip: !qdrantUrl }, async () => {
    const backend = new QdrantBackend();
    backend.baseUrl = qdrantUrl.replace(/\/$/, '');
    backend.apiKey = process.env.QDRANT_TEST_API_KEY || null;
    const collection = `similharity_test_${Date.now()}`;

    try {
        await backend.insertVectors(collection, [{ hash: 7, text: 'alice', vector: [1, 0] }], { type: 'chat', sourceId: 'alice' });
        await backend.insertVectors(collection, [{ hash: 7, text: 'bob', vector: [0, 1] }], { type: 'chat', sourceId: 'bob' });
        assert.equal((await backend.listItems(collection, { type: 'chat', sourceId: 'alice' })).length, 1);
        assert.equal((await backend.listItems(collection, { type: 'chat', sourceId: 'bob' })).length, 1);

        await backend.deleteVectors(collection, [7], { type: 'chat', sourceId: 'alice' });
        assert.equal((await backend.listItems(collection, { type: 'chat', sourceId: 'alice' })).length, 0);
        assert.equal((await backend.listItems(collection, { type: 'chat', sourceId: 'bob' })).length, 1);
    } finally {
        await backend.purgeAll(collection);
    }
});
