import { getRequestHeaders } from '../../../../../script.js';

const pluginPath = '/api/plugins/fandom';

function endpoint(type, operation) {
    if (!['fandom', 'mediawiki'].includes(type)) throw new Error('Select Fandom or MediaWiki.');
    return `${pluginPath}/${operation}${type === 'mediawiki' ? '-mediawiki' : ''}`;
}

function requestError(status) {
    if (status === 404) return 'Fandom Scraper plugin not found. Install it in SillyTavern, enable server plugins, and restart the server.';
    if (status === 403) return 'SillyTavern rejected the Wiki request (403). Refresh the page to renew your session and CSRF token.';
    if (status === 401) return 'Sign in to SillyTavern again before importing Wiki content.';
    return `Wiki scraper request failed (HTTP ${status}). Check the SillyTavern server log.`;
}

export async function checkWikiPlugin(type) {
    try {
        const response = await fetch(endpoint(type, 'probe'), { method: 'POST', headers: getRequestHeaders() });
        return { available: response.ok, message: response.ok ? '' : requestError(response.status) };
    } catch (error) {
        return { available: false, message: `Cannot reach the Wiki scraper: ${error.message}` };
    }
}

const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The upstream plugin expects a regex, and MediaWiki expects the path before the article. */
export function wikiRequest(type, input, pageFilter = '') {
    endpoint(type, 'scrape');
    input = String(input || '').trim();
    if (!input) throw new Error('Please enter a wiki URL or ID.');
    const filter = String(pageFilter).split(',').map(s => s.trim()).filter(Boolean);
    let article;
    let body;
    if (type === 'fandom' && /^[a-z0-9-]+$/i.test(input)) {
        body = { fandom: input };
    } else {
        let url;
        try { url = new URL(input.includes('://') ? input : `https://${input}`); }
        catch { throw new Error('Enter a valid Wiki URL.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Enter an HTTP or HTTPS Wiki URL without credentials.');
        const marker = url.pathname.indexOf('/wiki/');
        if (marker >= 0) article = decodeURIComponent(url.pathname.slice(marker + 6)).replaceAll('_', ' ');
        if (type === 'fandom') {
            const match = url.hostname.match(/^([a-z0-9-]+)\.fandom\.com$/i);
            if (!match) throw new Error('Enter a fandom.com URL or a Fandom wiki ID.');
            body = { fandom: match[1] };
        } else {
            if (marker >= 0) url.pathname = url.pathname.slice(0, marker + 5);
            url.search = ''; url.hash = '';
            body = { url: url.href.replace(/\/$/, '') };
        }
    }
    const names = filter.length ? filter : article ? [article] : [];
    return { ...body, filter: names.length ? `/^(?:${names.map(escapeRegex).join('|')})\\s*$/i` : '' };
}

export async function scrapeWikiPages(type, input, filter) {
    const body = wikiRequest(type, input, filter);
    const response = await fetch(endpoint(type, 'scrape'), {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(requestError(response.status));
    const pages = await response.json();
    if (!Array.isArray(pages)) throw new Error('Wiki scraper returned an invalid page list. Update the Fandom Scraper plugin.');
    if (pages.some(p => typeof p?.title !== 'string' || typeof p?.content !== 'string')) throw new Error('Wiki scraper returned a page without a title or content.');
    const usable = pages.map(p => ({ ...p, title: p.title.trim(), content: p.content.trim() })).filter(p => p.title && p.content);
    if (!usable.length) throw new Error('No Wiki content found. Check the wiki URL, page names, and server log.');
    return usable;
}
