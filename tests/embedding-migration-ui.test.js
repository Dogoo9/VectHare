// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ test: vi.fn(), switch: vi.fn(), migrate: vi.fn(), cutover: vi.fn(), rollback: vi.fn(), read: vi.fn() }));
vi.mock('../core/core-vector-api.js', () => ({ configuredLocalEmbeddingProfile: () => null }));
vi.mock('../core/embedding-migration.js', () => ({
    migrationPreview: () => ({ status: 'unknown', reason: 'Missing provenance' }), testEmbeddingConnection: mocks.test,
    reassignEmbeddingConnection: mocks.switch, migrateEmbeddingCollection: mocks.migrate,
    cutoverEmbeddingMigration: mocks.cutover, rollbackEmbeddingMigration: mocks.rollback,
    rollbackEmbeddingConnection: vi.fn(), readMigrationItems: mocks.read,
}));
import { extension_settings } from '../../../../extensions.js';
import { setCollectionMeta, getCollectionMeta } from '../core/collection-metadata.js';
import { openEmbeddingMigrationDialog } from '../ui/embedding-migration-dialog.js';
import { profile } from './embedding-fixtures.js';
const collection = { id: 'old', registryKey: 'standard:koboldcpp:old', backend: 'standard', source: 'koboldcpp', model: '', chunkCount: 20 };
let dialog;
const el = name => dialog.querySelector(`[data-${name}]`);
beforeEach(() => { vi.clearAllMocks(); extension_settings.vecthare = { collections: {} }; vi.stubGlobal('confirm', vi.fn(() => true));
    dialog = openEmbeddingMigrationDialog(collection, {}); el('endpoint').value = 'http://localhost:8080'; });
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });
describe('Embedding Provider / Migrate dialog', () => {
    it('shows physical storage, work estimate, caveat, and disables uncertified switching', () => {
        expect(el('current').textContent).toContain('standard / koboldcpp');
        expect(el('estimate').textContent).toContain('20 chunks');
        expect(dialog.textContent).toContain('768 dimensions prove nothing');
        expect(el('switch').disabled).toBe(true); expect(el('cutover').disabled).toBe(true);
    });
    it('previews unknown state and leaves compatible switch unavailable', async () => {
        el('preview').click(); await vi.waitFor(() => expect(el('status').textContent).toContain('unknown'));
        expect(el('switch').disabled).toBe(true); expect(mocks.switch).not.toHaveBeenCalled();
    });
    it('requires successful probes and an explicit confirmation; changing settings invalidates the test', async () => {
        mocks.test.mockResolvedValue({ status: 'compatible', reason: 'Matched', profile: profile() });
        el('test').click(); await vi.waitFor(() => expect(el('switch').disabled).toBe(false));
        el('switch').click(); await vi.waitFor(() => expect(mocks.switch).toHaveBeenCalledWith(collection.registryKey, expect.objectContaining({ source: 'koboldcpp' }), expect.objectContaining({ status: 'compatible' }), { confirmed: true, originalConnection: null }));
        expect(confirm).toHaveBeenCalled();
        el('model').value = 'changed'; el('model').dispatchEvent(new Event('input'));
        expect(el('switch').disabled).toBe(true);
    });
    it('does not save a switch when the user declines confirmation', async () => {
        mocks.test.mockResolvedValue({ status: 'compatible', reason: 'Matched', profile: profile() });
        el('test').click(); await vi.waitFor(() => expect(el('switch').disabled).toBe(false));
        confirm.mockReturnValue(false); el('switch').click(); await Promise.resolve(); expect(mocks.switch).not.toHaveBeenCalled();
    });
    it('exposes cancellation during staging and never activates a cancelled target', async () => {
        mocks.migrate.mockImplementation(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
        el('rebuild').click(); await vi.waitFor(() => expect(el('cancel').disabled).toBe(false));
        expect(el('source').disabled).toBe(true); el('cancel').click();
        await vi.waitFor(() => expect(el('status').textContent).toContain('Cancelled'));
        expect(el('cutover').disabled).toBe(true); expect(mocks.cutover).not.toHaveBeenCalled();
    });
    it('persists lexical retrieval choice and keeps incomplete chunks from being accepted', async () => {
        mocks.read.mockResolvedValue([{ hash: 7, text: 'key' }]);
        el('lexical').click(); await vi.waitFor(() => expect(getCollectionMeta(collection.registryKey).retrievalMode).toBe('lexical_only'));
        expect(mocks.test).not.toHaveBeenCalled();
        dialog.remove(); setCollectionMeta(collection.registryKey, { retrievalMode: 'lexical_only' });
        dialog = openEmbeddingMigrationDialog(collection, {}); el('dense').click();
        expect(getCollectionMeta(collection.registryKey).retrievalMode).toBe('dense');
    });
});
