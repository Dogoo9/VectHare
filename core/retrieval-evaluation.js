import { performance } from 'node:perf_hooks';
import {
    heuristicWeightedFusion,
    reciprocalRankFusion,
    weightedCombination
} from './fusion-algorithms.js';

export const EVALUATION_METHODS = Object.freeze([
    'dense', 'lexical', 'rrf', 'weighted', 'heuristic_weighted', 'reranker'
]);

const ids = results => results.map(result => result.result?.hash ?? result.hash);

/** Compute common retrieval metrics for one ranked result list. */
export function retrievalMetrics(ranking, relevance, k) {
    const selected = ranking.slice(0, k);
    const relevant = Object.values(relevance).filter(value => value > 0).length;
    const hits = selected.filter(id => (relevance[id] || 0) > 0).length;
    const first = ranking.findIndex(id => (relevance[id] || 0) > 0);
    const dcg = selected.reduce((sum, id, index) =>
        sum + ((2 ** (relevance[id] || 0)) - 1) / Math.log2(index + 2), 0);
    const ideal = Object.values(relevance).sort((a, b) => b - a).slice(0, k)
        .reduce((sum, grade, index) => sum + ((2 ** grade) - 1) / Math.log2(index + 2), 0);
    return {
        recall: relevant ? hits / relevant : 0,
        mrr: first < 0 ? 0 : 1 / (first + 1),
        ndcg: ideal ? dcg / ideal : 0,
        precision: selected.length ? hits / selected.length : 0
    };
}

function rank(query, method, options) {
    if (method === 'dense') return ids(query.dense);
    if (method === 'lexical') return ids(query.lexical);
    if (method === 'rrf') return ids(reciprocalRankFusion([query.dense, query.lexical], options.rrfK));
    if (method === 'weighted') return weightedCombination(query.dense, query.lexical,
        options.vectorWeight, options.textWeight).map(result => result.hash);
    if (method === 'heuristic_weighted') return ids(heuristicWeightedFusion(
        [query.dense, query.lexical], options.rrfK, options.heuristicSettings));
    if (method === 'reranker') return query.reranker || [];
    throw new Error(`Unknown evaluation method: ${method}`);
}

const summarize = values => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.length > 1
        ? values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1)
        : 0;
    const margin = 1.96 * Math.sqrt(variance / values.length);
    return { mean, variance, ci95: [Math.max(0, mean - margin), Math.min(1, mean + margin)] };
};

/**
 * Evaluate precomputed candidate rankings. Latency measures fusion only, avoiding
 * network/backend noise; retrieval and optional reranker latency should be added
 * by production dataset adapters.
 */
export function evaluateRetrieval(datasets, options = {}) {
    const config = { k: 3, rrfK: 60, vectorWeight: 0.5, textWeight: 0.5,
        latencyIterations: 200, heuristicSettings: {}, ...options };
    const methods = EVALUATION_METHODS.filter(method =>
        method !== 'reranker' || datasets.some(dataset => dataset.queries.some(query => query.reranker)));
    const results = {};
    for (const method of methods) {
        const perDataset = [];
        const latencies = [];
        for (const dataset of datasets) {
            const rows = dataset.queries.map(query => {
                let ranking;
                const started = performance.now();
                for (let iteration = 0; iteration < config.latencyIterations; iteration++) {
                    ranking = rank(query, method, config);
                }
                latencies.push((performance.now() - started) / config.latencyIterations);
                return retrievalMetrics(ranking, query.relevance, config.k);
            });
            const metric = name => summarize(rows.map(row => row[name]));
            perDataset.push({ name: dataset.name, queries: rows.length,
                recall: metric('recall'), mrr: metric('mrr'), ndcg: metric('ndcg'),
                precision: metric('precision') });
        }
        const aggregate = name => summarize(perDataset.map(dataset => dataset[name].mean));
        results[method] = { datasets: perDataset,
            aggregate: { recall: aggregate('recall'), mrr: aggregate('mrr'),
                ndcg: aggregate('ndcg'), precision: aggregate('precision') },
            meanFusionLatencyMs: latencies.reduce((a, b) => a + b, 0) / latencies.length };
    }
    return { config, methods: results };
}
