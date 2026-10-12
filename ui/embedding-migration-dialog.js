import { configuredLocalEmbeddingProfile } from '../core/core-vector-api.js';
import { getCollectionMeta, setCollectionMeta } from '../core/collection-metadata.js';
import { migrationPreview, testEmbeddingConnection, reassignEmbeddingConnection, rollbackEmbeddingConnection,
    migrateEmbeddingCollection, cutoverEmbeddingMigration, rollbackEmbeddingMigration, readMigrationItems } from '../core/embedding-migration.js';
import { indexLexicalItems } from '../core/lexical-index.js';
import { collectionStorageKey } from '../core/collection-portability.js';

/** DOM values are assigned as text; endpoints and fingerprints never become HTML. */
export function openEmbeddingMigrationDialog(collection, settings, onChanged = () => {}) {
    const key = collection.registryKey || `${collection.backend}:${collection.source}:${collection.id}`;
    const meta = getCollectionMeta(key);
    const locator = meta.storageLocator || { backend: collection.backend === 'vectra' ? 'standard' : collection.backend,
        source: collection.source, model: collection.model ?? '', collectionId: collection.id };
    const overlay = document.createElement('div');
    overlay.className = 'vecthare-modal-overlay vecthare-embedding-migration-overlay';
    overlay.innerHTML = `<section class="vecthare-embedding-migration-dialog" role="dialog" aria-modal="true" aria-label="Embedding Provider / Migrate">
        <h3>Embedding Provider / Migrate</h3><p data-current></p>
        <p>Matching filenames or 768 dimensions prove nothing. Compatible switching requires complete historical provenance and saved document/query probes. Unknown collections need a new text rebuild.</p>
        <label>Inference provider <select class="text_pole" data-source><option value="llamacpp">llama.cpp / local OpenAI-compatible</option><option value="koboldcpp">KoboldCpp</option></select></label>
        <label>Endpoint <input class="text_pole" data-endpoint type="url" placeholder="http://localhost:8080"></label>
        <label>Model ID <input class="text_pole" data-model></label>
        <label>Embedding fingerprint (JSON) <textarea class="text_pole" data-fingerprint rows="8"></textarea></label>
        <p>Use trusted artifact hashes/revisions and the server's actual pooling, tokenizer, normalization, task modes, prefixes, text cleaning, context, truncation and distance settings. This client applies prefixes and text cleaning; configure the remaining values on the server. An endpoint is contacted only when you choose Test or Rebuild. Browser CORS permission is required.</p>
        <div class="vecthare-migration-actions"><button class="menu_button vecthare-btn-sm" data-preview>Preview</button> <button class="menu_button vecthare-btn-sm" data-test>Test synthetic probes</button></div>
        <p data-status role="status" aria-live="polite"></p>
        <button class="menu_button vecthare-btn-sm vecthare-migration-primary" data-switch disabled>Confirm compatible inference switch</button>
        <hr><label>New target collection ID <input class="text_pole" data-target></label>
        <p data-estimate></p><p>The original remains readable. Rebuild pauses edits and auto-sync, leaves the new index disabled, and checks counts, text, metadata, vectors and rankings. Cancellation/failure cleans up the new target; restart uses a new ID.</p>
        <div class="vecthare-migration-actions"><button class="menu_button vecthare-btn-sm vecthare-migration-primary" data-rebuild>Confirm rebuild to new collection</button> <button class="menu_button vecthare-btn-sm" data-cancel disabled>Cancel rebuild</button>
        <button class="menu_button vecthare-btn-sm" data-cutover disabled>Confirm activation switch</button> <button class="menu_button vecthare-btn-sm" data-rollback disabled>Confirm rollback to original</button></div>
        <hr><div class="vecthare-migration-actions"><button class="menu_button vecthare-btn-sm" data-connection-rollback>Restore previous inference connection</button>
        <button class="menu_button vecthare-btn-sm" data-lexical>Build complete BM25 index and use lexical only</button>
        <button class="menu_button vecthare-btn-sm" data-dense>Use dense retrieval</button> <button class="menu_button vecthare-btn-sm" data-close>Close</button></div>
    </section>`;
    document.body.append(overlay);
    const el = name => overlay.querySelector(`[data-${name}]`);
    const current = meta.embeddingConnection || configuredLocalEmbeddingProfile(settings, locator.source, meta.embedding);
    el('current').textContent = `Physical storage: ${locator.backend} / ${locator.source} / ${locator.model || '(empty model namespace)'} / ${locator.collectionId}. Inference: ${current?.source || collection.source} / ${current?.endpoint || 'original configured endpoint'} / ${current?.model || collection.model || 'default'}.`;
    el('source').value = current?.source || 'llamacpp';
    el('endpoint').value = current?.endpoint || (settings.use_alt_endpoint ? settings.alt_endpoint_url : '') || '';
    el('model').value = current?.model || collection.model || 'default';
    el('fingerprint').value = JSON.stringify(meta.embedding?.fingerprint || {
        version: 1, artifact: '', revision: '', dimension: 768, pooling: '', normalization: '',
        documentPrefix: '', queryPrefix: '', documentTask: '', queryTask: '', tokenizer: '',
        truncation: '', maxTokens: 8192, distanceMetric: 'cosine', textCleaning: 'strip-markdown-html',
    }, null, 2);
    el('target').value = `vecthare_migration_${crypto.randomUUID().replaceAll('-', '')}`;
    el('estimate').textContent = `Estimated work: ${collection.chunkCount} chunks, ${Math.ceil(collection.chunkCount / 10)} write batches, plus synthetic probes and verification. Runtime depends on your local model.`;
    el('connection-rollback').disabled = !meta.previousEmbeddingConnection;
    let tested = null;
    let controller = null;
    let targetKey = meta.migration ? key : null;
    let sourceKey = meta.migration?.sourceKey || key;
    el('cutover').disabled = meta.migration?.status !== 'ready';
    el('rollback').disabled = meta.migration?.status !== 'active';
    const candidate = () => ({ source: el('source').value, endpoint: el('endpoint').value, model: el('model').value,
        fingerprint: JSON.parse(el('fingerprint').value) });
    const status = value => { el('status').textContent = value; };
    const run = async fn => { try { await fn(); } catch (error) { status(error.name === 'AbortError' ? 'Cancelled. Original collection is intact.' : error.message); } };
    for (const name of ['source', 'endpoint', 'model', 'fingerprint']) el(name).addEventListener('input', () => { tested = null; el('switch').disabled = true; });
    el('preview').onclick = () => run(async () => { const result = migrationPreview(getCollectionMeta(key), candidate()); status(`${result.status}: ${result.reason}`); });
    el('test').onclick = () => run(async () => {
        status('Testing public synthetic document and query probes...');
        const snapshot = JSON.stringify(candidate());
        tested = await testEmbeddingConnection(getCollectionMeta(key), JSON.parse(snapshot));
        if (snapshot !== JSON.stringify(candidate())) { tested = null; status('Profile changed during testing. Test again.'); return; }
        status(`${tested.status}: ${tested.reason}`); el('switch').disabled = tested.status !== 'compatible';
    });
    el('switch').onclick = () => run(async () => {
        if (!confirm(`Switch inference to ${tested?.profile.endpoint} (${tested?.profile.model}) while retaining this collection's original physical index?`)) return;
        const originalConnection = configuredLocalEmbeddingProfile(settings, locator.source, getCollectionMeta(key).embedding);
        await reassignEmbeddingConnection(key, locator, tested, { confirmed: true, originalConnection });
        status('Inference switched. Original physical locator retained.'); el('connection-rollback').disabled = false; onChanged();
    });
    el('rebuild').onclick = () => run(async () => {
        const targetId = el('target').value;
        const profile = candidate();
        if (!confirm(`Send ${collection.chunkCount} stored chunk texts to ${profile.endpoint} (${profile.model}) and rebuild into NEW disabled index ${targetId}? The original is retained.`)) return;
        controller = new AbortController();
        for (const name of ['rebuild', 'test', 'switch', 'source', 'endpoint', 'model', 'fingerprint', 'target', 'lexical', 'dense', 'connection-rollback', 'cutover', 'rollback']) el(name).disabled = true;
        el('cancel').disabled = false;
        try {
            status('Rebuild started: reading original chunks and checking the new target. It stays disabled until verification completes.');
            const result = await migrateEmbeddingCollection({ key, locator, settings, candidate: profile, targetId,
                signal: controller.signal, confirmed: true, onProgress: p => status(`Rebuilt ${p.written}/${p.total}. Verifying before activation...`) });
            targetKey = result.targetKey; sourceKey = key;
            status(`Verified ${result.written} chunks in ${result.targetLocator.collectionId}. New collection is disabled. Choose activation switch when ready.`);
            el('cutover').disabled = false; onChanged();
        } finally {
            controller = null; el('cancel').disabled = true;
            for (const name of ['rebuild', 'test', 'source', 'endpoint', 'model', 'fingerprint', 'target', 'lexical', 'dense']) el(name).disabled = false;
            el('target').value = `vecthare_migration_${crypto.randomUUID().replaceAll('-', '')}`;
        }
    });
    el('cancel').onclick = () => controller?.abort();
    el('cutover').onclick = () => run(async () => {
        if (!confirm('Activate the verified target and pause the original? Auto-sync stays off for the rebuilt snapshot.')) return;
        cutoverEmbeddingMigration(sourceKey, targetKey, { confirmed: true });
        status('Target activated; original retained.'); el('cutover').disabled = true; el('rollback').disabled = false; onChanged();
    });
    el('rollback').onclick = () => run(async () => {
        if (!confirm('Restore original collection activation and auto-sync, and disable the migration target?')) return;
        rollbackEmbeddingMigration(targetKey, { confirmed: true }); status('Original restored.'); el('rollback').disabled = true; el('cutover').disabled = false; onChanged();
    });
    el('connection-rollback').onclick = () => run(async () => {
        if (!confirm('Restore the previous inference connection?')) return;
        rollbackEmbeddingConnection(key, { confirmed: true }); status('Previous inference connection restored.'); el('connection-rollback').disabled = true; onChanged();
    });
    el('lexical').onclick = () => run(async () => {
        const routed = { ...settings, collection_locator: locator };
        const items = await readMigrationItems(locator.collectionId, routed);
        indexLexicalItems(collectionStorageKey(locator.collectionId, routed), items);
        setCollectionMeta(key, { retrievalMode: 'lexical_only', storageLocator: locator }); status('Complete BM25 text index built. Lexical-only retrieval selected; no dense inference was called.'); onChanged();
    });
    el('dense').onclick = () => { setCollectionMeta(key, { retrievalMode: 'dense' }); status('Dense retrieval selected.'); onChanged(); };
    el('close').onclick = () => { controller?.abort(); overlay.remove(); };
    return overlay;
}
