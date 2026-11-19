import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { extractSearchKeywords, init } from '../index.js';
import qdrantBackend from '../qdrant-backend.js';

const routes = new Map();
const middleware = [];
const router = { use: handler => middleware.push(handler) };
for (const method of ['get', 'post', 'patch', 'delete', 'put']) {
    router[method] = (route, handler) => routes.set(`${method.toUpperCase()} ${route}`, handler);
}
await init(router);

async function call(route, body, extra = {}) {
    const result = { status: 200 };
    const res = {
        status(code) { result.status = code; return res; },
        json(value) { result.body = value; return res; },
    };
    const req = { body, query: {}, params: {}, user: { directories: { vectors: extra.vectors } }, ...extra.req };
    let passed = true;
    for (const handler of middleware) {
        passed = false;
        handler(req, res, () => { passed = true; });
        if (!passed) return result;
    }
    await routes.get(route)(req, res);
    return result;
}

function captureEmbeddings(t) {
    const inputs = [];
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        inputs.push(JSON.parse(options.body).input);
        return new Response(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
    });
    return inputs;
}

const embedded = { backend: 'qdrant', collectionId: 'lore', source: 'koboldcpp', embeddingPrefix: 'prefix: ' };

test('open-folder passes a hostile folder name as one argument and never runs it', { skip: process.platform !== 'linux' }, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'similharity-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const name = '$(touch pwned)';
    const vectors = path.join(root, 'vectors');
    const folder = path.join(vectors, 'transformers', name);
    const bin = path.join(root, 'bin');
    const argsFile = path.join(root, 'args');
    await fs.mkdir(folder, { recursive: true });
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s' "$1" > '${argsFile}.tmp'\nmv '${argsFile}.tmp' '${argsFile}'\n`, { mode: 0o755 });
    const previous = { path: process.env.PATH, cwd: process.cwd() };
    process.env.PATH = `${bin}:${previous.path}`;
    process.chdir(root);
    t.after(() => { process.env.PATH = previous.path; process.chdir(previous.cwd); });

    const response = await call('POST /open-folder', { backend: 'vectra', collectionId: name }, { vectors });
    assert.equal(response.status, 200);
    let opened;
    for (let i = 0; i < 200 && opened === undefined; i++) {
        opened = await fs.readFile(argsFile, 'utf8').catch(() => undefined);
        if (opened === undefined) await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(opened, await fs.realpath(folder));
    await assert.rejects(fs.access(path.join(root, 'pwned')));
});

test('open-folder rejects traversal and symlinks outside the vectors directory', async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'similharity-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const vectors = path.join(root, 'vectors');
    await fs.mkdir(path.join(vectors, 'transformers'), { recursive: true });
    await fs.mkdir(path.join(root, 'outside'));
    await fs.symlink(path.join(root, 'outside'), path.join(vectors, 'transformers', 'link'));

    assert.equal((await call('POST /open-folder', { backend: 'vectra', collectionId: '..' }, { vectors })).status, 400);
    assert.equal((await call('POST /open-folder', { backend: 'vectra', collectionId: 'link' }, { vectors })).status, 400);
    assert.equal((await call('POST /open-folder', { backend: 'vectra', collectionId: 'missing' }, { vectors })).status, 404);
});

test('removed backends get a clear 400', async () => {
    for (const backend of ['lancedb', 'milvus']) {
        const response = await call('POST /chunks/list', { backend, collectionId: 'lore' });
        assert.equal(response.status, 400);
        assert.match(response.body.error, new RegExp(`Unsupported backend: ${backend}`));
    }
});

test('embeddingPrefix reaches query embeddings only', async t => {
    const inputs = captureEmbeddings(t);
    t.mock.method(qdrantBackend, 'queryVectors', async () => []);
    assert.equal((await call('POST /chunks/query', { ...embedded, searchText: 'hello' })).status, 200);
    assert.deepEqual(inputs, ['prefix: hello']);
});

test('hybrid query prefixes the embedding but not keywords', async t => {
    const inputs = captureEmbeddings(t);
    const hybrid = t.mock.method(qdrantBackend, 'hybridQuery', async () => []);
    await call('POST /chunks/hybrid-query', { ...embedded, searchText: 'The lantern, the Lantern and Mira!' });
    assert.deepEqual(inputs, ['prefix: The lantern, the Lantern and Mira!']);
    assert.deepEqual(hybrid.mock.calls[0].arguments[2], ['lantern', 'mira']);

    await call('POST /chunks/hybrid-query', { ...embedded, searchText: 'ignored words', keywords: ['Mira'] });
    assert.deepEqual(hybrid.mock.calls[1].arguments[2], ['Mira']);
});

test('insert and text update embed with the prefix and store plain text', async t => {
    const inputs = captureEmbeddings(t);
    const insert = t.mock.method(qdrantBackend, 'insertVectors', async () => {});
    const update = t.mock.method(qdrantBackend, 'updateItem', async () => {});
    await call('POST /chunks/insert', { ...embedded, items: [{ hash: 1, text: 'stored' }] });
    await call('PATCH /chunks/:hash/text', { ...embedded, text: 'edited' }, { req: { params: { hash: '1' } } });

    assert.deepEqual(inputs, ['prefix: stored', 'prefix: edited']);
    assert.equal(insert.mock.calls[0].arguments[1][0].text, 'stored');
    assert.equal(update.mock.calls[0].arguments[2].text, 'edited');
});

test('fallback keywords drop punctuation, stopwords and repeats and stop at ten', () => {
    assert.deepEqual(extractSearchKeywords("Well, the cat's CAT cat's and an owl."), ['well', "cat's", 'cat', 'owl']);
    assert.equal(extractSearchKeywords(Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ')).length, 10);
});
