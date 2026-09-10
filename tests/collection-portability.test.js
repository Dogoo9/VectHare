import { describe, expect, it, vi } from 'vitest';
import {
    collectionStorageKey, compareEmbeddingFingerprints, compareEmbeddingProbes,
    createEmbeddingFingerprint, rebuildCollection, storageSettings,
} from '../core/collection-portability.js';

const fingerprint = overrides => createEmbeddingFingerprint({
    artifact: 'sha256:nomic-v1.5-q8', revision: '1.5', dimension: 768,
    pooling: 'mean', normalization: 'l2', documentPrefix: 'search_document: ',
    queryPrefix: 'search_query: ', documentTask: 'retrieval.document',
    queryTask: 'retrieval.query', tokenizer: 'nomic-v1.5', truncation: 'end',
    maxTokens: 8192, distanceMetric: 'cosine', ...overrides,
});

describe('portable collection identity', () => {
    it('keeps a KoboldCPP physical locator while selecting llama.cpp embedding', () => {
        const settings = { source: 'llamacpp', vector_backend: 'standard', collection_locator: { backend: 'standard', source: 'koboldcpp', model: 'nomic-embed-text-v1.5.Q8_0.gguf' } };
        expect(storageSettings(settings)).toMatchObject({ source: 'koboldcpp', model: 'nomic-embed-text-v1.5.Q8_0.gguf' });
        expect(settings.source).toBe('llamacpp');
    });

    it('rejects semantic mismatches and leaves incomplete legacy provenance unknown', () => {
        expect(compareEmbeddingFingerprints(fingerprint(), fingerprint({ artifact: 'sha256:different' })).status).toBe('incompatible');
        expect(compareEmbeddingFingerprints(fingerprint(), fingerprint({ pooling: 'cls' })).status).toBe('incompatible');
        expect(compareEmbeddingFingerprints(fingerprint(), fingerprint({ normalization: 'none' })).status).toBe('incompatible');
        expect(compareEmbeddingFingerprints({ dimension: 768 }, { dimension: 768 }).status).toBe('unknown');
        expect(compareEmbeddingFingerprints(fingerprint(), fingerprint()).status).toBe('compatible');
    });

    it('validates both probes and rejects NaN, zero, dimension and changed-model output', () => {
        const probes = { document: [0.1, 0.2], query: [0.3, 0.4] };
        expect(compareEmbeddingProbes(probes, probes, 2).status).toBe('compatible');
        expect(compareEmbeddingProbes(probes, { ...probes, query: [0.3, 0.5] }, 2).status).toBe('incompatible');
        expect(compareEmbeddingProbes(probes, { document: [0, 0], query: [NaN, 1] }, 2).status).toBe('unknown');
    });

    it('isolates same names across physical namespaces', () => {
        expect(collectionStorageKey('same', { source: 'koboldcpp' })).not.toBe(collectionStorageKey('same', { source: 'llamacpp' }));
    });
});

describe('non-destructive rebuild', () => {
    it('completes a verified new target while preserving IDs and metadata', async () => {
        const items = [{ hash: 7, text: 'recoverable', metadata: { group: 'a' } }];
        const writeBatch = vi.fn();
        const result = await rebuildCollection({ source: 'old', target: 'new', items, writeBatch, verify: async () => ({ ok: true }) });
        expect(result.status).toBe('ready');
        expect(writeBatch).toHaveBeenCalledWith('new', items);
    });

    it.each(['failure', 'cancellation'])('rolls back target on %s without touching source', async mode => {
        const cleanupTarget = vi.fn();
        const controller = new AbortController();
        if (mode === 'cancellation') controller.abort();
        const promise = rebuildCollection({ source: 'old', target: 'new', items: [{ hash: 1, text: 'text' }], signal: controller.signal,
            writeBatch: mode === 'failure' ? async () => { throw new Error('partial'); } : vi.fn(), verify: vi.fn(), cleanupTarget });
        await expect(promise).rejects.toMatchObject({ rebuild: { status: 'rolled-back', source: 'old', target: 'new' } });
        expect(cleanupTarget).toHaveBeenCalledWith('new');
    });

    it('refuses collisions and missing source text before writing', async () => {
        await expect(rebuildCollection({ source: 'same', target: 'same', items: [], writeBatch: vi.fn(), verify: vi.fn() })).rejects.toThrow('distinct');
        await expect(rebuildCollection({ source: 'old', target: 'new', items: [{ hash: 1 }], writeBatch: vi.fn(), verify: vi.fn() })).rejects.toThrow('recoverable text');
    });
});
