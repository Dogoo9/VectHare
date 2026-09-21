import assert from 'node:assert/strict';
import test from 'node:test';

import { info, init } from '../index.js';

test('health endpoint exposes the discovery-compatible plugin contract', async () => {
    const routes = new Map();
    const router = {};
    for (const method of ['get', 'post', 'patch', 'delete', 'put']) {
        router[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
    }

    await init(router);
    let response;
    routes.get('GET /health')({}, { json: value => { response = value; } });

    assert.equal(info.id, 'similharity');
    assert.equal(response.success, true);
    assert.equal(response.available, true);
    assert.equal(response.plugin, 'similharity');
    assert.ok(response.features.includes('filesystem-discovery'));
});
