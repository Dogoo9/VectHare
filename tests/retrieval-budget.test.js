import { describe, expect, it, vi } from 'vitest';
import {
    collectAdaptiveCandidates,
    resolveRetrievalBudgets,
    selectFinalChunks,
} from '../core/retrieval-budget.js';

describe('retrieval budgets', () => {
    it('distinguishes candidate, reranker, and final limits', () => {
        expect(resolveRetrievalBudgets({ final_k: 5, candidate_k: 30, rerank_k: 12, candidate_k_max: 80 }))
            .toEqual({ finalK: 5, candidateK: 30, rerankK: 12, candidateKMax: 80 });
        expect(resolveRetrievalBudgets({ top_k: 5 }).candidateK).toBe(25);
        expect(resolveRetrievalBudgets({ top_k: 500 })).toMatchObject({
            finalK: 500,
            candidateK: 500,
            candidateKMax: 500,
        });
    });

    it('refills when disabled, duplicate, and condition-rejected leaders consume the first prefix', async () => {
        const ranked = Array.from({ length: 10 }, (_, i) => ({ id: i, score: 1 - i / 20 }));
        const fetchPrefix = vi.fn(limit => ranked.slice(0, limit));
        const hardFilter = candidates => candidates.filter(c => ![0, 1, 2, 3].includes(c.id));

        const result = await collectAdaptiveCandidates(fetchPrefix, hardFilter, {
            candidateK: 4, candidateKMax: 10, finalK: 3,
        });

        expect(fetchPrefix.mock.calls.map(([limit]) => limit)).toEqual([4, 8]);
        expect(result.map(c => c.id)).toEqual([4, 5, 6, 7]);
    });

    it('fills finalK from lower-ranked valid candidates after the score threshold', () => {
        const candidates = [
            { id: 'disabled', score: .99, disabled: true },
            { id: 'duplicate', score: .98, duplicate: true },
            { id: 'conditional', score: .97, conditionPasses: false },
            { id: 'below-threshold', score: .49 },
            { id: 'valid-1', score: .80 },
            { id: 'valid-2', score: .70 },
            { id: 'valid-3', score: .60 },
        ];
        const hardFiltered = candidates.filter(c => !c.disabled && !c.duplicate && c.conditionPasses !== false);
        const scored = hardFiltered.filter(c => c.score >= .5);

        expect(selectFinalChunks(scored, 3).map(c => c.id)).toEqual(['valid-1', 'valid-2', 'valid-3']);
    });

    it('never lets mandatory members expand the final output budget', () => {
        const rankedWithMandatoryMember = [
            { id: 'normal-1', score: .9 }, { id: 'normal-2', score: .8 },
            { id: 'mandatory', score: .1, forcedByGroup: 'group-a' },
        ];
        expect(selectFinalChunks(rankedWithMandatoryMember, 2)).toHaveLength(2);
    });

    it('prioritizes authoritative keyword hits over semantic score ties', () => {
        const candidates = [
            { id: 'semantic', score: 1 },
            { id: 'keyword', score: 1, keywordForceInjected: true },
        ];

        expect(selectFinalChunks(candidates, 1).map(c => c.id)).toEqual(['keyword']);
    });
});
