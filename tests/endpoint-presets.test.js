// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindAlternativeEndpointControls, getAlternativeEndpointHtml } from '../ui/endpoint-presets.js';

let settings;
let saved;
let onChanged;
const field = id => document.getElementById(`vecthare_${id}`);
function mount(snapshot) {
    settings = snapshot;
    document.body.innerHTML = `<div id="vecthare_settings">${getAlternativeEndpointHtml()}</div>`;
    onChanged = vi.fn(() => { saved = JSON.parse(JSON.stringify(settings)); });
    bindAlternativeEndpointControls(field('settings'), settings, onChanged);
}
function input(id, value) {
    field(id).value = value;
    field(id).dispatchEvent(new Event('input', { bubbles: true }));
}
function choose(url) {
    field('saved_endpoint').value = url;
    field('saved_endpoint').dispatchEvent(new Event('change', { bubbles: true }));
}
function enable() {
    field('use_alt_endpoint').checked = true;
    field('use_alt_endpoint').dispatchEvent(new Event('input', { bubbles: true }));
}
function saveEndpoint(url, name = '') {
    input('alt_endpoint_url', url);
    input('endpoint_name', name);
    field('save_endpoint').click();
}

beforeEach(() => mount({ source: 'llamacpp', use_alt_endpoint: false, alt_endpoint_url: 'http://localhost:5001' }));
afterEach(() => { document.body.innerHTML = ''; });

describe('saved alternative embedding endpoints', () => {
    it('preserves existing settings and manual entry without requiring presets', () => {
        expect(settings.saved_endpoints).toBeUndefined();
        expect(field('alt_endpoint_url').value).toBe('http://localhost:5001');
        expect(field('alt_endpoint_fields').hidden).toBe(true);
        expect(onChanged).not.toHaveBeenCalled();
        enable();
        input('alt_endpoint_url', 'http://172.20.10.2:5001');
        expect(saved).toMatchObject({ source: 'llamacpp', use_alt_endpoint: true, alt_endpoint_url: 'http://172.20.10.2:5001' });
        expect(field('alt_endpoint_fields').hidden).toBe(false);
    });

    it('persists multiple named endpoints and restores them after reopening settings', () => {
        enable();
        saveEndpoint('http://localhost:5001', 'Desktop');
        saveEndpoint('http://172.20.10.2:5001', 'Phone');
        mount(JSON.parse(JSON.stringify(saved)));
        expect(field('saved_endpoint').options).toHaveLength(3);
        expect(field('saved_endpoint').value).toBe('http://172.20.10.2:5001');
        expect(field('saved_endpoint').options[1].textContent).toBe('Desktop — http://localhost:5001');
        choose('http://localhost:5001');
        expect(saved.alt_endpoint_url).toBe('http://localhost:5001');
        expect(field('endpoint_name').value).toBe('Desktop');
    });

    it('enables Alternative Endpoint when choosing a saved address', () => {
        mount({ ...settings, saved_endpoints: [{ name: 'PC embeddings', url: 'http://172.20.10.2:5001' }] });
        choose('http://172.20.10.2:5001');
        expect(saved.use_alt_endpoint).toBe(true);
        expect(saved.alt_endpoint_url).toBe('http://172.20.10.2:5001');
        expect(field('use_alt_endpoint').checked).toBe(true);
        expect(field('alt_endpoint_fields').hidden).toBe(false);
    });

    it('updates an existing URL instead of creating duplicate entries', () => {
        enable();
        saveEndpoint('http://LOCALHOST:5001', 'Old name');
        saveEndpoint('http://localhost:5001/', 'EmbeddingGemma');
        expect(saved.saved_endpoints).toEqual([{ name: 'EmbeddingGemma', url: 'http://localhost:5001/' }]);
        expect(field('saved_endpoint').options).toHaveLength(2);
    });

    it('uses the URL as the name when no label is supplied', () => {
        enable();
        saveEndpoint('  http://[::1]:5001  ');
        expect(saved.saved_endpoints).toEqual([{ name: 'http://[::1]:5001', url: 'http://[::1]:5001' }]);
        expect(field('saved_endpoint').options[1].textContent).toBe('http://[::1]:5001');
    });

    it.each(['172.20.10.2:5001', 'file:///tmp/model', '', 'http://'])('rejects an invalid saved endpoint: %j', value => {
        enable();
        input('alt_endpoint_url', value);
        onChanged.mockClear();
        field('save_endpoint').click();
        expect(settings.saved_endpoints).toBeUndefined();
        expect(field('endpoint_status').textContent).toContain('Enter a full http:// or https://');
        expect(onChanged).not.toHaveBeenCalled();
    });

    it('removes a saved shortcut while retaining the active connection', () => {
        enable();
        saveEndpoint('http://localhost:5001', 'Desktop');
        field('delete_endpoint').click();
        expect(saved).toMatchObject({ saved_endpoints: [], alt_endpoint_url: 'http://localhost:5001', use_alt_endpoint: true });
        expect(field('saved_endpoint').value).toBe('');
        expect(field('delete_endpoint').disabled).toBe(true);
    });

    it('renders saved names as text and does not mistake manual edits for a saved selection', () => {
        enable();
        saveEndpoint('https://example.test:5001', '<img src=x onerror="alert(1)">');
        expect(field('saved_endpoint').options[1].textContent).toContain('<img');
        expect(document.querySelector('img')).toBeNull();
        input('alt_endpoint_url', 'https://another.test:5001');
        expect(field('saved_endpoint').value).toBe('');
        expect(field('delete_endpoint').disabled).toBe(true);
        expect(field('endpoint_name').value).toBe('');
        expect(saved.saved_endpoints).toHaveLength(1);
    });
});
