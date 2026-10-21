import { DUPLICATION_BACKENDS, duplicateCollection } from '../core/collection-duplicate.js';
import { getCollectionMeta } from '../core/collection-metadata.js';

/** Choose a physical destination without changing the global storage settings. */
export function openCollectionDuplicateDialog(collection, settings, onChanged = () => {}) {
    const key = collection.registryKey || `${collection.backend}:${collection.source || 'transformers'}:${collection.id}`;
    const locator = getCollectionMeta(key).storageLocator || {
        backend: collection.backend === 'vectra' ? 'standard' : collection.backend,
        source: collection.source || 'transformers', model: collection.model ?? '', collectionId: collection.id,
    };
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'vecthare-modal-overlay vecthare-duplicate-overlay';
    overlay.innerHTML = `<form class="vecthare-duplicate-dialog" role="dialog" aria-modal="true" aria-label="Duplicate collection">
        <h3>Duplicate collection</h3>
        <p data-source></p>
        <label>Destination storage<select class="text_pole" data-backend></select></label>
        <label>New collection name<input class="text_pole" data-name required maxlength="160" pattern="[a-zA-Z0-9_\\-]{1,160}" autocomplete="off"></label>
        <p class="vecthare-duplicate-hint">Use letters, numbers, underscores or hyphens. The copy keeps the stored embeddings and starts paused, with independent chunk settings. No re-embedding is needed.</p>
        <p class="vecthare-duplicate-hint">Similharity is required. Configure the destination connection in VectHare settings first. Milvus destinations are unavailable because its adapter uses shared storage.</p>
        <p data-status role="status" aria-live="polite"></p>
        <div class="vecthare-duplicate-actions">
            <button type="button" class="menu_button" data-close>Cancel</button>
            <button type="submit" class="menu_button vecthare-duplicate-submit" data-copy>Create duplicate</button>
        </div>
    </form>`;
    const el = name => overlay.querySelector(`[data-${name}]`);
    for (const [value, label] of Object.entries(DUPLICATION_BACKENDS)) {
        el('backend').add(new Option(label, value));
    }
    const milvus = new Option('Milvus — shared storage (unavailable)', 'milvus');
    milvus.disabled = true;
    el('backend').add(milvus);
    const sourceBackend = locator.backend === 'vectra' ? 'standard' : locator.backend;
    el('backend').value = Object.hasOwn(DUPLICATION_BACKENDS, sourceBackend) ? sourceBackend : 'qdrant';
    el('source').textContent = `Copy “${collection.name || collection.id}” from ${DUPLICATION_BACKENDS[sourceBackend] || sourceBackend}.`;
    el('name').value = `${String(collection.name || collection.id).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 155)}_copy`;
    let busy = false;
    const close = () => {
        if (busy) return;
        overlay.remove();
        previousFocus?.focus();
    };
    el('close').onclick = close;
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    for (const event of ['mousedown', 'touchstart']) overlay.addEventListener(event, e => e.stopPropagation());
    overlay.addEventListener('keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key !== 'Tab') return;
        const focusable = [...overlay.querySelectorAll('input:not(:disabled), select:not(:disabled), button:not(:disabled)')];
        const first = focusable[0], last = focusable.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    overlay.querySelector('form').addEventListener('submit', async event => {
        event.preventDefault();
        if (busy || el('copy').disabled) return;
        const name = el('name').value.trim();
        const targetBackend = el('backend').value;
        busy = true;
        for (const field of ['backend', 'name', 'copy', 'close']) el(field).disabled = true;
        el('status').textContent = 'Checking storage and reading the source…';
        let result;
        try {
            result = await duplicateCollection(key, name, { ...settings, collection_locator: locator }, {
                targetBackend, onProgress: message => { el('status').textContent = message; },
            });
            el('status').textContent = `Created “${result.collectionId}” in ${DUPLICATION_BACKENDS[targetBackend]} with ${result.chunkCount} chunks. Enable the copy when ready.`;
        } catch (error) {
            el('status').textContent = `Duplication failed: ${error.message}`;
        } finally {
            busy = false;
            el('close').disabled = false;
            el('close').textContent = 'Close';
            for (const field of ['backend', 'name', 'copy']) el(field).disabled = Boolean(result);
            (result ? el('close') : el('name')).focus();
            // Failed partial copies also need to appear in the browser, paused.
            try { await onChanged(result); } catch (error) { console.warn('VectHare: Could not refresh collections after duplication:', error); }
        }
    });
    document.body.append(overlay);
    el('name').focus();
    el('name').select();
    return overlay;
}
