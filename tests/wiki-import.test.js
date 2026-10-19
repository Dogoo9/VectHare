import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../../../../script.js', () => ({ getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' }) }));
import { checkWikiPlugin, scrapeWikiPages, wikiRequest } from '../core/wiki-import.js';

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

it.each(['fandom', 'mediawiki'])('probes %s with SillyTavern CSRF headers and accepts upstream 204', async type => {
    fetch.mockResolvedValue({ ok: true, status: 204 });
    expect(await checkWikiPlugin(type)).toEqual({ available: true, message: '' });
    expect(fetch).toHaveBeenCalledWith(`/api/plugins/fandom/probe${type === 'mediawiki' ? '-mediawiki' : ''}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' },
    });
});

it.each([[404, 'not found'], [403, 'CSRF'], [401, 'Sign in'], [500, 'server log']])('explains HTTP %s without misdiagnosing every failure as a missing plugin', async (status, message) => {
    fetch.mockResolvedValue({ ok: false, status });
    expect(await checkWikiPlugin('fandom')).toMatchObject({ available: false, message: expect.stringContaining(message) });
    await expect(scrapeWikiPages('fandom', 'baldursgate')).rejects.toThrow(message);
});

it('normalizes article URLs and converts comma-separated page names into a literal upstream regex', () => {
    const body = wikiRequest('mediawiki', 'https://en.wikipedia.org/wiki/Foo_Bar?oldid=123#section', 'Astarion, Mr. (Fox)');
    expect(body.url).toBe('https://en.wikipedia.org/wiki');
    const regex = new RegExp(body.filter.slice(1, -2), 'i');
    expect(regex.test('Mr. (Fox)\n')).toBe(true);
    expect(regex.test('Astarion\n')).toBe(true);
    expect(regex.test('MrX Fox')).toBe(false);
    expect(regex.test('Not Astarion')).toBe(false);
});

it('selects a linked article automatically and keeps roots as bulk scrapes', () => {
    expect(wikiRequest('fandom', 'baldursgate.fandom.com/wiki/Astarion')).toMatchObject({ fandom: 'baldursgate', filter: '/^(?:Astarion)\\s*$/i' });
    expect(wikiRequest('mediawiki', 'https://en.wikipedia.org/wiki/Foo_Bar').filter).toContain('Foo Bar');
    expect(wikiRequest('mediawiki', 'https://en.wikipedia.org/wiki/')).toEqual({ url: 'https://en.wikipedia.org/wiki', filter: '' });
    expect(wikiRequest('fandom', 'baldursgate')).toEqual({ fandom: 'baldursgate', filter: '' });
});

it('scrapes using the upstream contract, headers, and normalized page contents', async () => {
    fetch.mockResolvedValue({ ok: true, json: async () => [{ title: ' Gale ', content: ' Wizard ' }, { title: '', content: '' }] });
    expect(await scrapeWikiPages('fandom', 'https://baldursgate.fandom.com/', 'Gale')).toEqual([{ title: 'Gale', content: 'Wizard' }]);
    expect(fetch.mock.calls[0][0]).toBe('/api/plugins/fandom/scrape');
    expect(fetch.mock.calls[0][1].headers['X-CSRF-Token']).toBe('test-token');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(wikiRequest('fandom', 'baldursgate', 'Gale'));
});

it.each([null, {}, [{ title: 'Bad' }], [], [{ title: '', content: ' ' }]])('rejects malformed or empty pages %j', async pages => {
    fetch.mockResolvedValue({ ok: true, json: async () => pages });
    await expect(scrapeWikiPages('mediawiki', 'https://en.wikipedia.org/wiki/')).rejects.toThrow(/invalid|without|No Wiki/);
});

it('reports network errors and rejects invalid input before a scrape request', async () => {
    fetch.mockRejectedValue(new Error('offline'));
    expect(await checkWikiPlugin('fandom')).toMatchObject({ available: false, message: expect.stringContaining('offline') });
    fetch.mockClear();
    await expect(scrapeWikiPages('fandom', 'https://example.com')).rejects.toThrow('fandom.com');
    await expect(scrapeWikiPages('mediawiki', 'file:///tmp/wiki')).rejects.toThrow('HTTP');
    expect(fetch).not.toHaveBeenCalled();
});
