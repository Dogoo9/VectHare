/** Saved shortcuts for the existing alternative embedding endpoint setting. */
export function getAlternativeEndpointHtml() {
    return `
        <div class="vecthare_provider_setting" data-provider="ollama,vllm,llamacpp,koboldcpp,bananabread">
            <label for="vecthare_saved_endpoint"><small>Saved embedding endpoints</small></label>
            <div class="vecthare-endpoint-row">
                <select id="vecthare_saved_endpoint" class="vecthare-select" aria-label="Saved embedding endpoints"></select>
                <button type="button" id="vecthare_delete_endpoint" class="menu_button vecthare-btn-sm" disabled>Delete</button>
            </div>
            <label class="checkbox_label">
                <input type="checkbox" id="vecthare_use_alt_endpoint" />
                <span>Use Alternative Endpoint</span>
            </label>
            <div id="vecthare_alt_endpoint_fields">
                <label for="vecthare_alt_endpoint_url"><small>Embedding endpoint URL</small></label>
                <input type="text" id="vecthare_alt_endpoint_url" class="vecthare-input" inputmode="url" autocapitalize="none" spellcheck="false" placeholder="http://192.168.1.10:5001" />
                <small class="vecthare_hint">Use the embedding server address, including its port. Choosing a saved endpoint enables this override.</small>
                <label for="vecthare_endpoint_name"><small>Save as (optional)</small></label>
                <div class="vecthare-endpoint-row">
                    <input type="text" id="vecthare_endpoint_name" class="vecthare-input" placeholder="PC embeddings" />
                    <button type="button" id="vecthare_save_endpoint" class="menu_button vecthare-btn-sm">Save</button>
                </div>
            </div>
            <small id="vecthare_endpoint_status" class="vecthare_hint" role="status" aria-live="polite"></small>
        </div>`;
}

function endpointKey(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported endpoint protocol');
    return url.href.replace(/\/$/, '');
}

/** Bind to the settings snapshot; persistence follows the panel's normal save path. */
export function bindAlternativeEndpointControls(root, settings, onChanged) {
    const field = id => root.querySelector(`#vecthare_${id}`);
    const select = field('saved_endpoint');
    const enabled = field('use_alt_endpoint');
    const url = field('alt_endpoint_url');
    const fields = field('alt_endpoint_fields');
    const name = field('endpoint_name');
    const remove = field('delete_endpoint');
    const status = field('endpoint_status');
    const presets = () => Array.isArray(settings.saved_endpoints)
        ? settings.saved_endpoints.filter(item => typeof item?.url === 'string' && item.url.trim()) : [];
    const save = () => onChanged();

    function match() {
        try {
            const key = endpointKey(url.value.trim());
            return presets().find(item => {
                try { return endpointKey(item.url) === key; } catch { return false; }
            });
        } catch { return undefined; }
    }

    function refresh() {
        const options = [new Option('Custom endpoint', '')];
        for (const item of presets()) {
            const label = typeof item.name === 'string' && item.name.trim() ? item.name : item.url;
            options.push(new Option(label === item.url ? item.url : `${label} — ${item.url}`, item.url));
        }
        select.replaceChildren(...options);
        const current = match();
        select.value = settings.use_alt_endpoint && current ? current.url : '';
        remove.disabled = !select.value;
        name.value = typeof current?.name === 'string' ? current.name : '';
        enabled.checked = !!settings.use_alt_endpoint;
        fields.hidden = !enabled.checked;
    }

    url.value = settings.alt_endpoint_url || '';
    refresh();
    enabled.addEventListener('input', () => {
        settings.use_alt_endpoint = enabled.checked;
        refresh();
        save();
    });
    url.addEventListener('input', () => {
        settings.alt_endpoint_url = url.value;
        status.textContent = '';
        refresh();
        save();
    });
    select.addEventListener('change', () => {
        const selected = presets().find(item => item.url === select.value);
        if (!selected) {
            remove.disabled = true;
            name.value = '';
            return;
        }
        settings.alt_endpoint_url = selected.url;
        settings.use_alt_endpoint = true;
        url.value = selected.url;
        status.textContent = '';
        refresh();
        save();
    });
    field('save_endpoint').addEventListener('click', () => {
        const value = url.value.trim();
        try { endpointKey(value); } catch {
            status.textContent = 'Enter a full http:// or https:// endpoint address, including its port.';
            url.focus();
            return;
        }
        const existing = match();
        const entry = { name: name.value.trim() || value, url: value };
        settings.saved_endpoints = existing
            ? presets().map(item => item === existing ? entry : item)
            : [...presets(), entry];
        settings.alt_endpoint_url = value;
        url.value = value;
        refresh();
        status.textContent = 'Endpoint saved.';
        save();
    });
    remove.addEventListener('click', () => {
        if (!select.value) return;
        settings.saved_endpoints = presets().filter(item => item.url !== select.value);
        refresh();
        status.textContent = 'Saved endpoint deleted. The current connection is unchanged.';
        save();
    });
}
