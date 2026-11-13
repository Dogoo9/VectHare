import { describe, expect, it } from 'vitest';
import {
    fuseCollectionResults,
} from '../core/collection-fusion.js';

const embedding = {
    provider: 'openai', modelId: 'text-embedding-3-small', dimension: 1536,
    distanceMetric: 'cosine', indexVersion: 'v2',
};

describe('cross-collection fusion', () => {
    it('uses weighted RRF while preserving retrieval evidence', () => {
        const fusion = fuseCollectionResults([
            { collectionId: 'chat', collectionType: 'current_chat', collectionSize: 2, embedding, weight: 2,
                results: [{ hash: 'b', score: 0.2, rerankerScore: 0.8 }, { hash: 'a', score: 0.9 }] },
            { collectionId: 'docs', collectionType: 'external_document', collectionSize: 1,
                embedding: { ...embedding, modelId: 'other-model' }, weight: 1,
                results: [{ hash: 'c', score: 0.99, textScore: 3 }] },
        ], { rrfK: 60 });

        expect(fusion.heterogeneous).toBe(true);
        expect(fusion.results.map(result => result.hash)).toEqual(['b', 'a', 'c']);
        expect(fusion.results[0]).toMatchObject({
            score: 0.2,
            rawBackendScore: 0.2,
            withinCollectionRank: 1,
            retrievalMethod: 'vector',
            collectionSize: 2,
            collectionType: 'current_chat',
            fusionMethod: 'weighted_rrf',
        });
        expect(fusion.results[0].fusedScore).toBeCloseTo(2 / 61);
        expect(fusion.results[2].subScores.lexical).toBe(3);
    });

    it('does not expose an RRF contribution as the Qdrant match percentage', () => {
        const [result] = fuseCollectionResults([
            { collectionId: 'qdrant', collectionType: 'external_document', embedding,
                results: [{ hash: 'exact', score: 1, keywordBoosted: true }] },
        ]).results;

        expect(result.score).toBe(1);
        expect(result.rawBackendScore).toBe(1);
        expect(result.fusedScore).toBeCloseTo(1 / 61);
    });

    it('uses deterministic tie breakers ending in stable chunk id', () => {
        const tied = fuseCollectionResults([
            { collectionId: 'one', collectionType: 'external_document', embedding, results: [{ hash: 'z', score: 0.1 }] },
            { collectionId: 'two', collectionType: 'external_document', embedding, results: [{ hash: 'a', score: 0.9 }] },
        ]).results;
        expect(tied.map(r => r.hash)).toEqual(['a', 'z']);
    });
});
