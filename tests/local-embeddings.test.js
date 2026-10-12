import { describe, expect, it, vi } from 'vitest';
import { embedLocal, embeddingUrl, validateVectors, preprocessEmbedding, probeLocal, SYNTHETIC_PROBES } from '../providers/local-embeddings.js';
import { profile, fingerprint, probes, response } from './embedding-fixtures.js';

describe('local OpenAI-compatible embeddings', () => {
    it('retries transient inference failures at the same configured endpoint', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 }).mockResolvedValueOnce(response([[1, 0]]));
        await expect(embedLocal(['key'], profile({ probes: null }), { fetchImpl })).resolves.toMatchObject({ vectors: [[1, 0]] });
        expect(fetchImpl.mock.calls.map(c => c[0])).toEqual(['http://localhost:8080/v1/embeddings', 'http://localhost:8080/v1/embeddings']);
    });
    it.each(['http://localhost:8080', 'http://localhost:8080/v1', 'http://localhost:8080/v1/embeddings'])('normalizes endpoint %s', endpoint => {
        expect(embeddingUrl(endpoint)).toBe('http://localhost:8080/v1/embeddings');
    });
    it.each(['file:///tmp/a', 'http://secret:token@localhost', 'http://localhost?api_key=secret', 'http://localhost#secret', '/relative', 'bad'])('rejects unsafe URL %s', url => {
        expect(() => embeddingUrl(url)).toThrow();
    });
    it('normalizes out-of-order indexed output and keeps batch dimensions consistent', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ index: 1, embedding: [2, 3] }, { index: 0, embedding: [1, 2] }] }) }));
        const result = await embedLocal(['a', 'b', 'c', 'd'], profile({ probes: null, batchSize: 2 }), { fetchImpl });
        expect(result.vectors).toEqual([[1, 2], [2, 3], [1, 2], [2, 3]]);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0][1]).toMatchObject({ credentials: 'omit', redirect: 'error' });
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ input: ['search_document: a', 'search_document: b'], encoding_format: 'float' });
    });
    it.each([
        [], [0, 0], [NaN, 1], [Infinity, 1], [1], ['1', 2],
    ])('rejects malformed vector %j', vector => {
        expect(() => validateVectors({ data: [{ index: 0, embedding: vector }] }, 1, 2)).toThrow();
    });
    it.each([
        [{ index: 0, embedding: [1, 2] }, { index: 0, embedding: [2, 1] }],
        [{ index: 0, embedding: [1, 2] }, { index: 2, embedding: [2, 1] }],
        [{ embedding: [1, 2] }, { index: 1, embedding: [2, 1] }],
        [{ index: 0, embedding: [1, 2] }],
    ])('rejects duplicate, missing or misaligned indexed rows', data => {
        expect(() => validateVectors({ data }, 2, 2)).toThrow();
    });
    it('rejects changing dimensions across batches even without an expected dimension', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(response([[1, 2]])).mockResolvedValueOnce(response([[1, 2, 3]]));
        await expect(embedLocal(['a', 'b'], profile({ fingerprint: {}, probes: null, batchSize: 1 }), { fetchImpl })).rejects.toThrow('dimension');
    });
    it('applies distinct query/document prefixes and accepts deliberate empty prefixes', () => {
        expect(preprocessEmbedding('needle', profile(), 'query')).toBe('search_query: needle');
        expect(preprocessEmbedding('needle', profile(), 'document')).toBe('search_document: needle');
        expect(fingerprint({ queryPrefix: '' }).queryPrefix).toBe('');
    });
    it('checks both public probes before sending private text', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(response([probes.document])).mockResolvedValueOnce(response([probes.query])).mockResolvedValueOnce(response([[1, 1]]));
        await embedLocal(['private'], profile(), { fetchImpl, mode: 'query' });
        expect(JSON.parse(fetchImpl.mock.calls[0][1].body).input[0]).toBe('search_document: ' + SYNTHETIC_PROBES.document);
        expect(JSON.parse(fetchImpl.mock.calls[1][1].body).input[0]).toBe('search_query: ' + SYNTHETIC_PROBES.query);
        expect(JSON.parse(fetchImpl.mock.calls[2][1].body).input).toEqual(['search_query: private']);
    });
    it('catches a new model at the same endpoint before private text leaves the browser', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(response([[1, 0]])).mockResolvedValueOnce(response([[0, 1]]));
        await expect(embedLocal(['private'], profile(), { fetchImpl })).rejects.toThrow('verification failed');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(fetchImpl.mock.calls)).not.toContain('private');
    });
    it('catches changed reported models even if probe values match', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(response([probes.document], 'different'));
        await expect(embedLocal(['private'], profile({ reportedModel: 'old' }), { fetchImpl })).rejects.toThrow('different model');
    });
    it('does not reflect HTTP response errors, private text, or keys', async () => {
        const fetchImpl = vi.fn(async () => ({ ok: false, status: 401, text: async () => 'private secret' }));
        await expect(embedLocal(['private'], profile({ apiKey: 'secret', probes: null }), { fetchImpl })).rejects.toThrow('HTTP 401');
        expect(fetchImpl).toHaveBeenCalledOnce();
        expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
    });
    it('rejects newline credentials before any request', async () => {
        const fetchImpl = vi.fn();
        await expect(embedLocal(['a'], profile({ apiKey: 'bad\nkey' }), { fetchImpl })).rejects.toThrow('credential');
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('times out and aborts the actual fetch', async () => {
        const fetchImpl = vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))));
        await expect(embedLocal(['a'], profile({ timeoutMs: 5, probes: null }), { fetchImpl })).rejects.toThrow('timed out');
    });
    it('honors cancellation before starting and never falls back', async () => {
        const fetchImpl = vi.fn(); const controller = new AbortController(); controller.abort();
        await expect(embedLocal(['a'], profile(), { fetchImpl, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
    it('uses fixed public probes without including credentials in its result', async () => {
        const fetchImpl = vi.fn().mockResolvedValueOnce(response([probes.document])).mockResolvedValueOnce(response([probes.query]));
        expect(await probeLocal(profile({ apiKey: 'secret' }), { fetchImpl })).toEqual({ probes, reportedModel: 'synthetic-nomic' });
    });
});
