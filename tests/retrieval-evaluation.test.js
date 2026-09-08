import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { evaluateRetrieval, retrievalMetrics } from '../core/retrieval-evaluation.js';
import { heuristicWeightedFusion, reciprocalRankFusion } from '../core/fusion-algorithms.js';

describe('standard RRF', () => {
    it('orders solely by reciprocal-rank contributions while preserving raw scores', () => {
        const dense = [{ hash: 'a', score: 0.01 }, { hash: 'b', score: 0.99 }];
        const lexical = [{ hash: 'a', bm25Score: 0.01 }, { hash: 'b', bm25Score: 100 }];
        const results = reciprocalRankFusion([dense, lexical], 60);
        expect(results.map(row => row.result.hash)).toEqual(['a', 'b']);
        expect(results[0].rrfScore).toBe(results[0].rawRrfScore);
        expect(results[0].vectorScore).toBe(0.01);
        expect(results[0].textScore).toBe(0.01);
    });

    it('keeps the old score heuristic behind an explicit method', () => {
        const lists = [
            [{ hash: 'a', score: 0.01 }, { hash: 'b', score: 0.99 }],
            [{ hash: 'a', bm25Score: 0.01 }, { hash: 'b', bm25Score: 100 }]
        ];
        expect(heuristicWeightedFusion(lists).map(row => row.result.hash)).toEqual(['b', 'a']);
    });
});

describe('retrieval evaluation', () => {
    it('computes graded and binary metrics', () => {
        expect(retrievalMetrics(['bad', 'best'], { best: 3 }, 2)).toMatchObject({
            recall: 1, mrr: 0.5, precision: 0.5
        });
    });

    it('compares all fusion paths with per-dataset variance and confidence intervals', () => {
        const datasets = JSON.parse(fs.readFileSync(
            new URL('../evaluation/retrieval-datasets.json', import.meta.url), 'utf8'));
        const report = evaluateRetrieval(datasets, { latencyIterations: 2 });
        expect(Object.keys(report.methods)).toEqual([
            'dense', 'lexical', 'rrf', 'weighted', 'heuristic_weighted', 'reranker'
        ]);
        expect(report.methods.rrf.datasets).toHaveLength(2);
        expect(report.methods.rrf.datasets[0].ndcg.variance).toBeGreaterThanOrEqual(0);
        expect(report.methods.rrf.aggregate.recall.ci95).toHaveLength(2);
        expect(report.methods.rrf.meanFusionLatencyMs).toBeGreaterThanOrEqual(0);
    });
});
