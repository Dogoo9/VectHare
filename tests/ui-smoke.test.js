// @vitest-environment jsdom
/**
 * Smoke test for the UI modules: renders the settings panel and opens each
 * modal against stubbed SillyTavern APIs, failing on any thrown error or
 * console.error. This catches broken imports, undefined references and
 * missing template elements, which the unit tests do not cover.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import $ from 'jquery';
import { defaultSettings } from '../core/default-settings.js';

const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ success: true, items: [], collections: [], results: [], hashes: [], healthy: true }),
    text: async () => '',
}));

let errors;

beforeAll(() => {
    $.fx.off = true;
});

beforeEach(async () => {
    errors = [];
    vi.stubGlobal('$', $);
    vi.stubGlobal('jQuery', $);
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() });
    vi.stubGlobal('confirm', vi.fn(() => false));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.map(String).join(' ')));
    window.addEventListener('error', event => errors.push(String(event.error)));

    const { extension_settings } = await import('../../../../extensions.js');
    extension_settings.vecthare = { collections: {}, vecthare_collection_registry: [] };
    document.body.innerHTML = '<div id="extensions_settings2"></div>';
});

afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

function baseSettings() {
    return structuredClone(defaultSettings);
}

describe('UI smoke test', () => {
    it('renders the settings panel and its sections', async () => {
        const { renderSettings } = await import('../ui/ui-manager.js');
        const callbacks = { onVectorizeAll: vi.fn(), onPurge: vi.fn(), onRunDiagnostics: vi.fn() };
        renderSettings('extensions_settings2', baseSettings(), callbacks);
        await flush();

        expect(document.querySelector('#vecthare_settings')).not.toBeNull();
        expect(document.querySelector('#vecthare_log_level').value).toBe('info');
        $('#vecthare_purge').trigger('click');
        expect(callbacks.onPurge).toHaveBeenCalled();
        // Exercise a few change handlers.
        $('#vecthare_source').val('openai').trigger('change');
        $('#vecthare_log_level').val('debug').trigger('change');
        await flush();
        expect(errors).toEqual([]);
    });

    it('opens the diagnostics modal', async () => {
        const { renderSettings } = await import('../ui/ui-manager.js');
        const { openDiagnosticsModal } = await import('../ui/diagnostics-modal.js');
        renderSettings('extensions_settings2', baseSettings(), { onVectorizeAll: vi.fn(), onPurge: vi.fn(), onRunDiagnostics: vi.fn() });
        openDiagnosticsModal();
        await flush();
        expect($('#vecthare_diagnostics_modal').length).toBe(1);
        expect(errors).toEqual([]);
    });

    it('opens the database browser', async () => {
        const { initializeDatabaseBrowser, openDatabaseBrowser } = await import('../ui/database-browser.js');
        initializeDatabaseBrowser(baseSettings());
        await openDatabaseBrowser();
        await flush();
        expect(document.querySelector('#vecthare_database_browser_modal')).not.toBeNull();
        expect(errors).toEqual([]);
    });

    it('opens the chunk visualizer', async () => {
        const { initializeVisualizer, openVisualizer } = await import('../ui/chunk-visualizer.js');
        initializeVisualizer();
        openVisualizer({ chunks: [{ hash: 1, index: 0, text: 'A <b>memory</b>', metadata: { keywords: ['x"y'] } }], collectionType: 'chat' }, 'vecthare_chat_test', baseSettings());
        await flush();
        expect(document.querySelector('.vecthare-chunk-item')).not.toBeNull();
        expect(document.body.innerHTML).not.toContain('<b>memory</b>');
        expect(errors).toEqual([]);
    });

    it('opens the content vectorizer', async () => {
        const { openContentVectorizer } = await import('../ui/content-vectorizer.js');
        await openContentVectorizer();
        await flush();
        expect(document.querySelector('#vecthare_content_vectorizer_modal, .vecthare-content-vectorizer-modal, #vecthare_cv_modal')).not.toBeNull();
        expect(errors).toEqual([]);
    });

    it('opens the search debug modal with no prior search', async () => {
        const { openSearchDebugModal } = await import('../ui/search-debug.js');
        openSearchDebugModal();
        await flush();
        expect(errors).toEqual([]);
    });

    it('opens the text cleaning manager', async () => {
        const { openTextCleaningManager } = await import('../ui/text-cleaning-manager.js');
        openTextCleaningManager();
        await flush();
        expect(errors).toEqual([]);
    });
});
