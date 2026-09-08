/** Pure, backend-independent hybrid retrieval fusion algorithms. */

export const DEFAULT_RRF_K = 60;

export const HEURISTIC_WEIGHTED_DEFAULTS = Object.freeze({
    bm25SaturationK: 3.0, vectorWeight: 0.55, textWeight: 0.45, signalThreshold: 0.01,
    dualSignalBonus: 0.08, dualRankBase: 0.95, dualRankWeight: 0.05,
    vectorOnlyWeight: 0.55, textOnlyWeight: 0.60, singleRankBase: 0.90,
    singleRankWeight: 0.10, fallbackWeight: 0.25
});

/**
 * Reciprocal Rank Fusion (RRF)
 *
 * Combines multiple ranked lists using the formula:
 *   rrfScore(d) = Σ 1 / (k + rank_i(d))
 *
 * Where:
 * - d = document
 * - k = constant (typically 60)
 * - rank_i(d) = rank of document d in result list i (1-indexed)
 *
 * @param {Array[]} resultLists - Arrays of ranked results [{hash, score, ...}]
 * @param {number} k - RRF constant (default 60)
 * Raw component scores are retained for display; they never affect ordering.
 * @returns {Array} Fused and sorted results
 */
export function reciprocalRankFusion(resultLists, k = DEFAULT_RRF_K) {
    const fusedScores = new Map();
    const listNames = ['vector', 'text'];

    resultLists.forEach((results, listIdx) => {
        if (!results || !Array.isArray(results)) return;

        results.forEach((result, rank) => {
            const docId = result.hash;
            if (docId === undefined || docId === null) return;

            if (!fusedScores.has(docId)) {
                fusedScores.set(docId, {
                    result,
                    rrfScore: 0,
                    rawRrfScore: 0,
                    ranks: {},
                    vectorScore: 0,
                    textScore: 0
                });
            }

            // RRF contribution: 1 / (k + rank)
            // rank is 0-indexed, so add 1 for 1-indexed ranking
            const rrfContribution = 1 / (k + rank + 1);
            const entry = fusedScores.get(docId);
            entry.rawRrfScore += rrfContribution;
            entry.ranks[listNames[listIdx]] = rank + 1;

            // Store individual scores for debugging
            if (listIdx === 0) {
                entry.vectorScore = result.score || 0;
            } else {
                entry.textScore = result.bm25Score || result.score || 0;
            }
        });
    });

    return Array.from(fusedScores.values())
        .map(entry => ({ ...entry, rrfScore: entry.rawRrfScore }))
        .sort((a, b) => b.rawRrfScore - a.rawRrfScore);
}

/** Legacy heuristic formerly embedded in RRF. It is opt-in and may rerank RRF. */
export function heuristicWeightedFusion(resultLists, k = DEFAULT_RRF_K, options = {}) {
    const config = { ...HEURISTIC_WEIGHTED_DEFAULTS, ...options };
    const results = reciprocalRankFusion(resultLists, k);
    const maxRrf = results[0]?.rawRrfScore || 0;
    for (const entry of results) {
        const rankFactor = maxRrf ? entry.rawRrfScore / maxRrf : 0;
        const vector = entry.vectorScore || 0;
        const normalizedText = entry.textScore / (entry.textScore + config.bm25SaturationK) || 0;
        const hasVector = vector > config.signalThreshold;
        const hasText = normalizedText > config.signalThreshold;
        if (hasVector && hasText) {
            const combined = vector * config.vectorWeight + normalizedText * config.textWeight;
            const bonus = 1 + Math.min(vector, normalizedText) * config.dualSignalBonus;
            entry.combinedScore = combined * bonus * (config.dualRankBase + config.dualRankWeight * rankFactor);
        } else if (hasVector) {
            entry.combinedScore = vector * config.vectorOnlyWeight * (config.singleRankBase + config.singleRankWeight * rankFactor);
        } else if (hasText) {
            entry.combinedScore = normalizedText * config.textOnlyWeight * (config.singleRankBase + config.singleRankWeight * rankFactor);
        } else {
            entry.combinedScore = rankFactor * config.fallbackWeight;
        }
        entry.combinedScore = Math.min(1, entry.combinedScore);
        entry.normalizedTextScore = normalizedText;
    }
    return results.sort((a, b) => b.combinedScore - a.combinedScore);
}
/**

 * Weighted Linear Combination
 *
 * Combines vector and text scores using weighted sum after normalization:
 *   combinedScore = α * normalizedVectorScore + β * normalizedTextScore
 *
 * @param {Array} vectorResults - Vector search results [{hash, score, ...}]
 * @param {Array} textResults - Text/BM25 search results [{hash, bm25Score, ...}]
 * @param {number} alpha - Weight for vector scores (default 0.5)
 * @param {number} beta - Weight for text scores (default 0.5)
 * @returns {Array} Combined and sorted results
 */
export function weightedCombination(vectorResults, textResults, alpha = 0.5, beta = 0.5) {
    // Normalize scores to [0, 1]
    const normalizedVector = normalizeScores(vectorResults, 'score');
    const normalizedText = normalizeScores(textResults, 'bm25Score');

    const combined = new Map();

    // Add all vector results
    for (const r of normalizedVector) {
        if (r.hash === undefined || r.hash === null) continue;

        combined.set(r.hash, {
            result: r,
            hash: r.hash,
            text: r.text,
            metadata: r.metadata,
            vectorScore: r.score || 0,
            textScore: 0,
            normalizedVectorScore: r.normalizedScore,
            normalizedTextScore: 0,
            combinedScore: alpha * r.normalizedScore
        });
    }

    // Merge text results
    for (const r of normalizedText) {
        if (r.hash === undefined || r.hash === null) continue;

        if (combined.has(r.hash)) {
            const entry = combined.get(r.hash);
            entry.textScore = r.bm25Score || 0;
            entry.normalizedTextScore = r.normalizedScore;
            entry.combinedScore += beta * r.normalizedScore;
        } else {
            combined.set(r.hash, {
                result: r,
                hash: r.hash,
                text: r.text,
                metadata: r.metadata,
                vectorScore: 0,
                textScore: r.bm25Score || 0,
                normalizedVectorScore: 0,
                normalizedTextScore: r.normalizedScore,
                combinedScore: beta * r.normalizedScore
            });
        }
    }

    // Sort by combined score (descending)
    return Array.from(combined.values())
        .sort((a, b) => b.combinedScore - a.combinedScore);
}

/**
 * Min-max normalization of scores to [0, 1] range
 *
 * @param {Array} results - Results with scores
 * @param {string} scoreField - Field name containing the score
 * @returns {Array} Results with added normalizedScore field
 */
function normalizeScores(results, scoreField = 'score') {
    if (!results || results.length === 0) return [];

    const scores = results.map(r => r[scoreField] || 0);
    const minScore = Math.min(...scores);
    const maxScore = Math.max(...scores);
    const range = maxScore - minScore || 1; // Avoid division by zero

    return results.map(r => ({
        ...r,
        normalizedScore: ((r[scoreField] || 0) - minScore) / range
    }));
}
