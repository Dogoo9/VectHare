// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../core/collection-duplicate.js', () => ({
    DUPLICATION_BACKENDS: { standard: 'Standard (Vectra)', lancedb: 'LanceDB', qdrant: 'Qdrant' },
    duplicateCollection: vi.fn(),
}));
import { duplicateCollection } from '../core/collection-duplicate.js';
import { openCollectionDuplicateDialog } from '../ui/collection-duplicate-dialog.js';
import { setCollectionMeta } from '../core/collection-metadata.js';
import { extension_settings } from '../../../../extensions.js';

const collection = { id: 'old', name: 'My collection', backend: 'qdrant', source: 'koboldcpp', registryKey: 'qdrant:koboldcpp:old' };
const locator = { backend: 'qdrant', source: 'koboldcpp', model: 'saved-model', collectionId: 'old' };
const el = name => document.querySelector(`[data-${name}]`);
const submit = () => document.querySelector('form').requestSubmit();
const result = { collectionId: 'new_copy', chunkCount: 15 };
beforeEach(() => {
    vi.resetAllMocks();
    extension_settings.vecthare = { collections: {} };
    setCollectionMeta(collection.registryKey, { storageLocator: locator });
});
afterEach(() => { document.body.innerHTML = ''; });

it('defaults to source storage, offers supported destinations, and safely displays names', () => {
    openCollectionDuplicateDialog({ ...collection, name: '<img src=x onerror=alert(1)>' }, {});
    expect(el('backend').value).toBe('qdrant');
    expect([...el('backend').options].filter(o => !o.disabled).map(o => o.value)).toEqual(['standard', 'lancedb', 'qdrant']);
    expect(document.querySelector('img')).toBeNull();
    expect(el('name').checkValidity()).toBe(true);
    el('close').click();
    expect(document.querySelector('form')).toBeNull();
    expect(duplicateCollection).not.toHaveBeenCalled();
});

it('copies to the chosen backend with the saved source locator and closes without a second copy', async () => {
    duplicateCollection.mockResolvedValue(result);
    const changed = vi.fn();
    openCollectionDuplicateDialog(collection, { vector_backend: 'standard', source: 'openai' }, changed);
    el('backend').value = 'lancedb'; el('name').value = 'new_copy'; submit();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(result));
    expect(duplicateCollection).toHaveBeenCalledWith(collection.registryKey, 'new_copy', expect.objectContaining({ collection_locator: locator }), expect.objectContaining({ targetBackend: 'lancedb' }));
    expect(el('status').textContent).toContain('LanceDB with 15 chunks');
    expect(el('copy').disabled).toBe(true);
    submit();
    expect(duplicateCollection).toHaveBeenCalledTimes(1);
    el('close').click(); expect(document.querySelector('form')).toBeNull();
});

it('blocks repeated submission and dismissal while copying and displays progress', async () => {
    let resolve;
    duplicateCollection.mockImplementation((_key, _name, _settings, options) => {
        options.onProgress('Copying 100 / 150 chunks…');
        return new Promise(done => { resolve = done; });
    });
    openCollectionDuplicateDialog(collection, {}); submit(); submit();
    expect(duplicateCollection).toHaveBeenCalledTimes(1);
    expect(el('status').textContent).toBe('Copying 100 / 150 chunks…');
    for (const field of ['backend', 'name', 'copy', 'close']) expect(el(field).disabled).toBe(true);
    document.querySelector('.vecthare-duplicate-overlay').click();
    el('name').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('form')).not.toBeNull();
    resolve(result);
    await vi.waitFor(() => expect(el('close').disabled).toBe(false));
});

it('refreshes partial copies on failure and allows a corrected name to be retried', async () => {
    duplicateCollection.mockRejectedValueOnce(new Error('Name already exists')).mockResolvedValueOnce(result);
    const changed = vi.fn();
    openCollectionDuplicateDialog(collection, {}, changed); submit();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(undefined));
    expect(el('status').textContent).toContain('Name already exists');
    expect(el('copy').disabled).toBe(false);
    el('name').value = 'new_copy'; submit();
    await vi.waitFor(() => expect(changed).toHaveBeenCalledWith(result));
    expect(duplicateCollection).toHaveBeenCalledTimes(2);
});

it('rejects invalid names before starting work and restores focus on cancel', () => {
    const opener = document.createElement('button'); document.body.append(opener); opener.focus();
    openCollectionDuplicateDialog(collection, {});
    el('name').value = 'bad/name'; submit();
    expect(duplicateCollection).not.toHaveBeenCalled();
    el('close').click(); expect(document.activeElement).toBe(opener);
});
