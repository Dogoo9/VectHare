import { createEmbeddingFingerprint } from '../core/collection-portability.js';
export const fingerprint = overrides => createEmbeddingFingerprint({
    artifact: 'sha256:synthetic-nomic', revision: 'v1.5', dimension: 2, pooling: 'mean', normalization: 'l2',
    documentPrefix: 'search_document: ', queryPrefix: 'search_query: ', documentTask: 'document', queryTask: 'query',
    tokenizer: 'synthetic-tokenizer-1', truncation: 'end', maxTokens: 8192, distanceMetric: 'cosine', textCleaning: 'none', ...overrides,
});
export const probes = { document: [1, 0.5], query: [0.5, 1] };
export const profile = overrides => ({ source: 'llamacpp', endpoint: 'http://localhost:8080', model: 'synthetic-nomic', fingerprint: fingerprint(), probes, ...overrides });
export const response = (vectors, model = 'synthetic-nomic') => ({ ok: true, json: async () => ({ model, data: vectors.map((embedding, index) => ({ index, embedding })) }) });
