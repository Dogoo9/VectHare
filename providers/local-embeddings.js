import { compareEmbeddingProbes } from '../core/collection-portability.js';

export const SYNTHETIC_PROBES = Object.freeze({
    document: 'A small brass key opens the blue garden gate.',
    query: 'Which key opens the garden gate?',
});

/** Only an explicitly configured HTTP(S) endpoint is contacted. No redirects or fallback. */
export function embeddingUrl(endpoint) {
    let url;
    try { url = new URL(endpoint); } catch { throw new Error('Configure an absolute embedding endpoint URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Embedding URLs must use HTTP(S), without credentials, query strings, or fragments.');
    }
    url.pathname = url.pathname.replace(/\/$/, '').replace(/\/v1(?:\/embeddings)?$/, '') + '/v1/embeddings';
    return url.href;
}

export function validateVectors(data, count, dimension) {
    if (!Array.isArray(data?.data) || data.data.length !== count) throw new Error('Embedding response count differs from input.');
    const vectors = Array(count);
    for (const item of data.data) {
        const i = item?.index;
        const v = item?.embedding;
        if (!Number.isInteger(i) || i < 0 || i >= count || vectors[i]) throw new Error('Embedding response has invalid or duplicate indices.');
        if (!Array.isArray(v) || !v.length || !v.every(Number.isFinite) || !v.some(x => x !== 0)) {
            throw new Error('Embedding response contains an empty, zero, or non-finite vector.');
        }
        dimension ??= v.length;
        if (v.length !== dimension) throw new Error('Embedding response dimension differs from the configured embedding space.');
        vectors[i] = v;
    }
    return vectors;
}

export function preprocessEmbedding(text, profile, mode = 'document') {
    if (!['document', 'query'].includes(mode)) throw new Error('Invalid embedding task mode.');
    if (typeof text !== 'string' || !text.trim()) throw new Error('Embedding input requires nonempty text.');
    // Tokenization, pooling, context and truncation are server configuration;
    // do not approximate them by character slicing or invent unsupported API fields.
    return (profile.fingerprint?.[`${mode}Prefix`] || '') + text;
}

export async function embedLocal(texts, profile, { mode = 'document', signal, onProgress, fetchImpl = fetch, verify = true } = {}) {
    const url = embeddingUrl(profile.endpoint);
    if (profile.apiKey && (typeof profile.apiKey !== 'string' || /[\r\n]/.test(profile.apiKey))) throw new Error('Invalid embedding credential.');
    const batchSize = profile.batchSize ?? 10;
    const timeoutMs = profile.timeoutMs ?? 60000;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 512 || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Invalid embedding batch size or timeout.');
    if (!Array.isArray(texts)) throw new Error('Embedding inputs must be an array.');
    let dimension = profile.fingerprint?.dimension;
    if (dimension !== undefined && (!Number.isInteger(dimension) || dimension < 1)) throw new Error('Invalid embedding dimension.');
    let reportedModel;
    const requestOnce = async (input, requestMode) => {
        signal?.throwIfAborted();
        const controller = new AbortController();
        const abort = () => controller.abort(signal.reason);
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetchImpl(url, {
                method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
                headers: { 'Content-Type': 'application/json', ...(profile.apiKey ? { Authorization: `Bearer ${profile.apiKey}` } : {}) },
                body: JSON.stringify({ input: input.map(t => preprocessEmbedding(t, profile, requestMode)), model: profile.model || 'default', encoding_format: 'float' }),
            });
            if (!response.ok) {
                const error = new Error(`Local embedding request failed (HTTP ${response.status}).`);
                error.retryable = [429, 502, 503, 504].includes(response.status);
                throw error;
            }
            let data;
            try { data = await response.json(); } catch { throw new Error('Local embedding response is not JSON.'); }
            if (reportedModel && data.model && reportedModel !== data.model) throw new Error('Embedding model changed during the request.');
            if (profile.reportedModel && data.model !== profile.reportedModel) throw new Error('Embedding endpoint now reports a different model. Re-test or rebuild.');
            reportedModel = data.model || reportedModel;
            const vectors = validateVectors(data, input.length, dimension);
            dimension ??= vectors[0]?.length;
            return vectors;
        } catch (error) {
            if (signal?.aborted) signal.throwIfAborted();
            if (controller.signal.aborted) throw new Error('Local embedding request timed out.');
            // Do not reflect a server response, URL, private text or credential in errors.
            if (error instanceof TypeError) throw new Error('Local embedding endpoint is unreachable; check CORS and URL configuration.');
            throw error;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    };
    const request = async (input, requestMode) => {
        const attempts = profile.maxAttempts ?? 2;
        if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new Error('Invalid embedding retry count.');
        for (let attempt = 1; ; attempt++) {
            try { return await requestOnce(input, requestMode); } catch (error) {
                if (!error.retryable || attempt >= attempts || signal?.aborted) throw error;
                await new Promise((resolve, reject) => {
                    const aborted = () => { clearTimeout(timer); reject(signal.reason); };
                    const timer = setTimeout(() => { signal?.removeEventListener('abort', aborted); resolve(); }, 100 * attempt);
                    signal?.addEventListener('abort', aborted, { once: true });
                });
                signal?.throwIfAborted();
            }
        }
    };
    // Revalidate BEFORE private text: catches a different model loaded at the same URL,
    // including servers that always report a generic model label.
    if (verify && profile.probes && texts.length) {
        const document = (await request([SYNTHETIC_PROBES.document], 'document'))[0];
        const query = (await request([SYNTHETIC_PROBES.query], 'query'))[0];
        const check = compareEmbeddingProbes(profile.probes, { document, query }, dimension);
        if (check.status !== 'compatible') throw new Error(`Embedding endpoint verification failed: ${check.reason}`);
    }
    const vectors = [];
    for (let i = 0; i < texts.length; i += batchSize) {
        vectors.push(...await request(texts.slice(i, i + batchSize), mode));
        onProgress?.(vectors.length, texts.length);
    }
    return { vectors, model: reportedModel || profile.model || 'default' };
}

export async function probeLocal(profile, options = {}) {
    const document = await embedLocal([SYNTHETIC_PROBES.document], profile, { ...options, mode: 'document', verify: false });
    const query = await embedLocal([SYNTHETIC_PROBES.query], profile, { ...options, mode: 'query', verify: false });
    if (document.model !== query.model) throw new Error('Embedding model changed between document and query probes.');
    return { probes: { document: document.vectors[0], query: query.vectors[0] }, reportedModel: query.model };
}
