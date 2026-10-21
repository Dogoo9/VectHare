// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import $ from 'jquery';

vi.mock('../core/core-vector-api.js', () => ({ deleteVectorItems: vi.fn(), insertVectorItems: vi.fn(), updateChunkText: vi.fn(), updateChunkMetadata: vi.fn() }));
vi.mock('../core/scenes.js', () => ({ filterSceneChunks: () => [], filterNonSceneChunks: chunks => chunks,
    deleteSceneChunk: vi.fn(), updateSceneChunkMetadata: vi.fn(), getPendingScene: () => null }));
vi.mock('../../../../../script.js', async importOriginal => ({ ...await importOriginal(), eventSource: { emit: vi.fn() } }));

import { extension_settings } from '../../../../extensions.js';
import { getChunkMetadata, setCollectionMeta, saveChunkMetadata } from '../core/collection-metadata.js';
import { openVisualizer } from '../ui/chunk-visualizer.js';

const source = 'qdrant:koboldcpp:source';
const copy = 'qdrant:koboldcpp:copy';
const settings = { collection_locator: { backend: 'qdrant', source: 'koboldcpp', model: '', collectionId: 'copy' } };
const chunks = Array.from({ length: 60 }, (_, index) => ({ hash: index, index, text: `Memory ${index}`, metadata: {} }));
const el = selector => document.querySelector(selector);
const click = selector => el(selector).click();
const enterBulk = () => click('#vecthare_chunk_bulk_mode');
const checkbox = index => el(`.vecthare-chunk-item[data-uid="chunk_${index}_${index}"] input`);

beforeEach(() => {
    $.fx.off = true;
    vi.stubGlobal('$', $);
    vi.stubGlobal('toastr', { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn() });
    vi.stubGlobal('confirm', vi.fn(() => true));
    extension_settings.vecthare = { collections: {} };
    setCollectionMeta(source, {});
    setCollectionMeta(copy, {});
    openVisualizer({ chunks, collectionType: 'lorebook' }, 'copy', settings);
});
afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); });

it('renders real checkboxes, tracks native clicks, and changes only selected chunks', () => {
    expect(el('.vecthare-chunk-select')).toBeNull();
    enterBulk();
    expect(document.querySelectorAll('.vecthare-chunk-select')).toHaveLength(50);
    expect(el('#vecthare_chunk_bulk_disable').disabled).toBe(true);
    checkbox(1).click();
    expect(checkbox(1).checked).toBe(true);
    expect(el('#vecthare_chunk_bulk_count').textContent).toBe('1 selected');
    click('#vecthare_chunk_bulk_disable');
    expect(getChunkMetadata(1, copy)).toMatchObject({ enabled: false, disabled: true });
    expect(getChunkMetadata(2, copy)).toBeNull();
    expect(getChunkMetadata(1, source)).toBeNull();
    checkbox(1).click();
    expect(el('#vecthare_chunk_bulk_count').textContent).toBe('0 selected');
    expect(el('#vecthare_chunk_bulk_enable').disabled).toBe(true);
});

it('keeps selections across pagination and filtering and reports hidden selections', () => {
    enterBulk(); checkbox(1).click(); click('#vecthare_load_more'); checkbox(59).click();
    $('#vecthare_chunk_sort').val('index-r').trigger('change');
    expect(checkbox(1).checked).toBe(true);
    expect(checkbox(59).checked).toBe(true);
    saveChunkMetadata(3, { enabled: false, disabled: true }, copy);
    click('#vecthare_chunk_bulk_disable');
    $('#vecthare_chunk_filter').val('enabled').trigger('change');
    expect(el('#vecthare_chunk_bulk_count').textContent).toBe('2 selected (2 hidden by filter)');
    click('#vecthare_chunk_bulk_enable');
    expect(getChunkMetadata(1, copy).enabled).toBe(true);
    expect(getChunkMetadata(59, copy).enabled).toBe(true);
    expect(getChunkMetadata(3, copy).enabled).toBe(false);
});

it('selects all filtered matches beyond the current page and clears selection', () => {
    enterBulk(); click('#vecthare_chunk_bulk_select_filtered');
    expect(el('#vecthare_chunk_bulk_count').textContent).toBe('60 selected');
    click('#vecthare_chunk_bulk_disable');
    expect(getChunkMetadata(59, copy).enabled).toBe(false);
    click('#vecthare_chunk_bulk_clear');
    expect(document.querySelectorAll('.vecthare-chunk-select:checked')).toHaveLength(0);
    expect(el('#vecthare_chunk_bulk_disable').disabled).toBe(true);
});

it('supports row selection and persists enablement independently after reopening', () => {
    saveChunkMetadata(1, { enabled: true }, source);
    enterBulk();
    click('[data-uid="chunk_1_1"] .vecthare-chunk-item-name');
    expect(checkbox(1).checked).toBe(true);
    expect(el('#vecthare_detail_enabled')).toBeNull();
    click('#vecthare_chunk_bulk_disable');
    extension_settings.vecthare = JSON.parse(JSON.stringify(extension_settings.vecthare));
    openVisualizer({ chunks, collectionType: 'lorebook' }, 'copy', settings);
    expect(el('[data-uid="chunk_1_1"]').classList.contains('disabled')).toBe(true);
    expect(getChunkMetadata(1, source).enabled).toBe(true);
    enterBulk();
    expect(checkbox(1).checked).toBe(false);
});

it('clears the selection when bulk mode is exited', () => {
    enterBulk(); checkbox(1).click(); enterBulk();
    expect(el('.vecthare-chunk-select')).toBeNull();
    enterBulk(); expect(checkbox(1).checked).toBe(false);
    expect(el('#vecthare_chunk_bulk_count').textContent).toBe('0 selected');
});

it('keeps collection-browser bulk controls separate when the visualizer is open above them', () => {
    const browser = document.createElement('div');
    browser.innerHTML = '<span id="vecthare_bulk_count">7 selected</span><button id="vecthare_bulk_enable" disabled></button><button id="vecthare_bulk_disable" disabled></button>';
    document.body.prepend(browser);
    const browserAction = vi.fn();
    $('#vecthare_bulk_disable').on('click', browserAction);
    openVisualizer({ chunks, collectionType: 'lorebook' }, 'copy', settings);
    enterBulk(); checkbox(1).click(); click('#vecthare_chunk_bulk_disable');
    expect(getChunkMetadata(1, copy).enabled).toBe(false);
    expect(el('#vecthare_bulk_count').textContent).toBe('7 selected');
    expect(el('#vecthare_bulk_enable').disabled).toBe(true);
    expect(el('#vecthare_bulk_disable').disabled).toBe(true);
    expect(browserAction).not.toHaveBeenCalled();
});
