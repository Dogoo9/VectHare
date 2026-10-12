import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ backend: null }));
vi.mock('../backends/backend-manager.js', () => ({ getBackend: vi.fn(async () => state.backend) }));
import { getBackend } from '../backends/backend-manager.js';
import { getStorageHashes } from '../core/storage-hashes.js';
it('enumerates every page without initialization/inference and preserves physical routing', async () => {
    const values = Array.from({ length: 1201 }, (_, hash) => ({ hash }));
    state.backend = { listChunks: vi.fn(async (_id, _settings, { offset, limit }) => ({ items: values.slice(offset, offset + limit), total: values.length })) };
    expect(await getStorageHashes('old', { source: 'llamacpp', collection_locator: { source: 'koboldcpp', model: 'old' } })).toHaveLength(1201);
    expect(state.backend.listChunks).toHaveBeenCalledTimes(3);
    expect(getBackend.mock.calls.at(-1)[0]).toMatchObject({ _storageReadOnly: true, source: 'koboldcpp', model: 'old' });
});
it.each(['incomplete', 'duplicate', 'changed'])('rejects %s enumeration instead of treating partial coverage as complete', async mode => {
    state.backend = { listChunks: vi.fn(async (_id, _settings, { offset }) => {
        if (mode === 'duplicate') return { items: [{ hash: 7 }, { hash: 7 }], total: 2 };
        return { items: offset ? [] : [{ hash: 7 }], total: mode === 'changed' && offset ? 3 : 2 };
    }) };
    await expect(getStorageHashes('old', {})).rejects.toThrow();
});
