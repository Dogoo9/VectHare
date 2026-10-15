// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTrace, createDebugData, openSearchDebugModal, setLastSearchDebug } from '../ui/search-debug.js';

let data;
let copyReport;
beforeEach(() => {
    // Exercise the public modal renderer; event handlers need no jQuery runtime.
    const chain = {
        remove: vi.fn(), on: vi.fn(), off: vi.fn(), fadeIn: vi.fn(),
        append: html => { document.body.innerHTML = html; return chain; },
    };
    for (const method of ['remove', 'on', 'off', 'fadeIn']) chain[method].mockReturnValue(chain);
    vi.stubGlobal('$', selector => selector === '#vecthare_copy_diagnostic' ? {
        ...chain,
        on: (_event, handler) => { copyReport = handler; return chain; },
    } : chain);
    vi.stubGlobal('toastr', { success: vi.fn(), warning: vi.fn() });
    data = createDebugData();
    data.collectionId = 'qdrant:llamacpp:vecthare_import_example';
});

describe('copying search diagnostics', () => {
    it('uses the clipboard when available', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        renderFailure();
        await copyReport();
        expect(writeText).toHaveBeenCalledWith(expect.stringContaining('VECTHARE DEBUG DUMP'));
        expect(toastr.success).toHaveBeenCalled();
        expect(document.getElementById('vecthare_diagnostic_copy')).toBeNull();
    });

    it('shows a selectable report when the clipboard API is missing on local HTTP', async () => {
        vi.stubGlobal('navigator', {});
        addTrace(data, 'vector_search', 'Query failed', { error: 'Embedding endpoint unavailable' });
        renderFailure();
        await copyReport();
        const field = document.querySelector('[aria-label="Diagnostic report"]');
        expect(field.readOnly).toBe(true);
        expect(field.value).toContain('Embedding endpoint unavailable');
        document.querySelector('#vecthare_diagnostic_copy button').click();
        expect(document.activeElement).toBe(field);
        expect(field.selectionStart).toBe(0);
        expect(field.selectionEnd).toBe(field.value.length);
        expect(toastr.success).not.toHaveBeenCalled();
    });

    it('keeps the full report available when clipboard permissions are denied', async () => {
        const writeText = vi.fn().mockRejectedValue(new Error('NotAllowedError'));
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        data.query = 'A query containing </textarea><img src=x onerror="alert(1)">';
        renderFailure();
        await copyReport();
        const card = document.getElementById('vecthare_diagnostic_copy');
        expect(card.querySelector('textarea').value).toContain(data.query);
        expect(card.querySelector('img')).toBeNull();
        await copyReport();
        expect(document.querySelectorAll('#vecthare_diagnostic_copy')).toHaveLength(1);
        expect(toastr.success).not.toHaveBeenCalled();
    });

    it('removes the manual report if a later copy succeeds', async () => {
        const writeText = vi.fn().mockRejectedValueOnce(new Error('Denied')).mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });
        renderFailure();
        await copyReport();
        expect(document.getElementById('vecthare_diagnostic_copy')).not.toBeNull();
        await copyReport();
        expect(document.getElementById('vecthare_diagnostic_copy')).toBeNull();
        expect(toastr.success).toHaveBeenCalledTimes(1);
    });
});
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

function renderFailure() {
    setLastSearchDebug(data);
    openSearchDebugModal();
    return document.querySelector('.vecthare-debug-critical-failure');
}

describe('search failure diagnosis', () => {
    it('shows the underlying llama.cpp endpoint error instead of claiming there were no matches', () => {
        const error = 'Configure the llama.cpp embedding server URL in SillyTavern or VectHare alternate endpoint settings.';
        addTrace(data, 'vector_search', `Query failed for ${data.collectionId}`, { collectionId: data.collectionId, error });
        const failure = renderFailure();
        expect(failure.textContent).toContain(error);
        expect(failure.textContent).toContain('Vector search encountered an error');
        expect(failure.textContent).not.toContain('No matches returned');
        expect(failure.textContent).not.toContain('send some messages');
    });

    it('shows each failed collection and reads older traces without a collectionId field', () => {
        addTrace(data, 'vector_search', 'Query failed for first', { collectionId: 'first', error: 'HTTP 500' });
        addTrace(data, 'vector_search', 'Query failed for second', { error: 'Embedding dimension mismatch' });
        const failure = renderFailure();
        expect(failure.textContent).toContain('Query failed for "first": HTTP 500');
        expect(failure.textContent).toContain('Query failed for second: Embedding dimension mismatch');
    });

    it('renders backend error bodies as text', () => {
        const error = '<img src=x onerror="alert(1)">';
        addTrace(data, 'vector_search', 'Query failed', { error });
        const failure = renderFailure();
        expect(failure.querySelector('.vecthare-debug-diagnosis-detail').textContent).toContain(error);
        expect(failure.querySelector('img')).toBeNull();
    });

    it('keeps empty successful searches distinct from failed requests', () => {
        addTrace(data, 'vector_search', `Query completed for ${data.collectionId}`, { hashesReturned: 0 });
        const failure = renderFailure();
        expect(failure.textContent).toContain('Vector search returned no results');
        expect(failure.textContent).toContain('No matches returned');
        expect(failure.textContent).toContain('If chunks are present');
        expect(failure.textContent).not.toContain('send some messages');
    });

    it('supports saved debug data without a trace', () => {
        delete data.trace;
        expect(renderFailure().textContent).toContain('Vector search returned no results');
    });
});
