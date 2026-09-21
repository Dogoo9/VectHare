import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import vectra from 'vectra';

test('declared Vectra package can create and open a local index', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'similharity-vectra-'));
    try {
        const index = new vectra.LocalIndex(directory);
        await index.createIndex();
        assert.equal(await index.isIndexCreated(), true);
        assert.deepEqual(await index.listItems(), []);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
