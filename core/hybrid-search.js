/**
 * ============================================================================
 * HYBRID SEARCH MODULE
 * ============================================================================
 * True hybrid search combining dense vector similarity with full-text (BM25)
 * search using Reciprocal Rank Fusion (RRF) or weighted linear combination.
 *
 * Supports both native backend hybrid search (Qdrant/Milvus) and client-side
 * fusion for backends without native support (Standard/LanceDB).
 *
 * @version 1.0.0
 * ============================================================================
 */

import { getBackend } from '../backends/backend-manager.js';
import { createBM25Scorer, tokenize } from './bm25-scorer.js';
import { loadLexicalIndex, searchLexicalIndex } from './lexical-index.js';
import { collectionStorageKey, storageSettings } from './collection-portability.js';

import { DEFAULT_RRF_K, HEURISTIC_WEIGHTED_DEFAULTS, heuristicWeightedFusion } from './fusion-algorithms.js';
export { DEFAULT_RRF_K, HEURISTIC_WEIGHTED_DEFAULTS } from './fusion-algorithms.js';

function getHeuristicSettings(settings) {
    const result = {};
    for (const key of Object.keys(HEURISTIC_WEIGHTED_DEFAULTS)) {
        const settingKey = `hybrid_heuristic_${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)}`;
        if (settings[settingKey] !== undefined) result[key] = Number(settings[settingKey]);
    }
    return result;
}

/**
 * Perform hybrid search combining vector and full-text results
 *
 * @param {string} collectionId - Collection to search
 * @param {string} searchText - Query text
 * @param {number} topK - Number of results to return
 * @param {object} settings - VectHare settings
 * @param {object} options - Hybrid search options
 * @returns {Promise<{hashes: number[], metadata: object[]}>}
 */
export async function hybridSearch(collectionId, searchText, topK, settings, options = {}) {
    settings = storageSettings(settings);
    const backend = await getBackend(settings);

    const {
        fusionMethod = settings.hybrid_fusion_method || 'heuristic_weighted',
        vectorWeight = settings.hybrid_vector_weight ?? 0.5,
        textWeight = settings.hybrid_text_weight ?? 0.5,
        rrfK = settings.hybrid_rrf_k || DEFAULT_RRF_K,
        heuristicSettings = getHeuristicSettings(settings),
        queryVector = null
    } = options;

    // Check if backend supports native hybrid search and user prefers it
    const preferNative = settings.hybrid_native_prefer !== false;
    if (preferNative && fusionMethod !== 'heuristic_weighted' &&
        backend.supportsHybridSearch && backend.supportsHybridSearch()) {
        console.log(`[HybridSearch] Using native hybrid search (${backend.constructor.name})`);
        try {
            return await backend.hybridQuery(collectionId, searchText, topK, settings, {
                vectorWeight,
                textWeight,
                fusionMethod,
                rrfK
            });
        } catch (error) {
            console.warn(`[HybridSearch] Native hybrid failed, falling back to client-side:`, error.message);
            // Fall through to client-side fusion
        }
    }

    // Client-side fusion for backends without native support
    console.log(`[HybridSearch] Using client-side ${fusionMethod.toUpperCase()} fusion`);
    return clientSideHybridSearch(
        backend,
        collectionId,
        searchText,
        topK,
        settings,
        { fusionMethod, vectorWeight, textWeight, rrfK, heuristicSettings, queryVector }
    );
}

/**
 * Client-side hybrid search using dual queries + fusion
 *
 * @param {object} backend - Vector backend instance
 * @param {string} collectionId - Collection to search
 * @param {string} searchText - Query text
 * @param {number} topK - Number of results to return
 * @param {object} settings - VectHare settings
 * @param {object} options - Fusion options
 * @returns {Promise<{hashes: number[], metadata: object[]}>}
 */
async function clientSideHybridSearch(backend, collectionId, searchText, topK, settings, options) {
    const {
        fusionMethod,
        vectorWeight,
        textWeight,
        rrfK,
        queryVector,
        heuristicSettings
    } = options;

    // Fetch more results for fusion (need candidates from both methods)
    const expandedTopK = Math.min(topK * 3, 100);

    // 1. Vector search
    console.log(`[HybridSearch] Fetching ${expandedTopK} vector results from collection: ${collectionId}`);
    console.log(`[HybridSearch] Backend: ${backend.constructor.name}, Source: ${settings.source}`);

    let vectorResults = { hashes: [], metadata: [] };
    try {
        vectorResults = await backend.queryCollection(
            collectionId,
            searchText,
            expandedTopK,
            settings,
            queryVector
        );
        console.log(`[HybridSearch] Raw vector results:`, vectorResults ? `hashes=${vectorResults.hashes?.length}, metadata=${vectorResults.metadata?.length}` : 'null');
    } catch (error) {
        console.error(`[HybridSearch] Vector query failed:`, error);
    }

    if (!vectorResults?.metadata) vectorResults = { hashes: [], metadata: [] };

    // Lexical candidates come from the complete collection index, independently
    // of which documents the dense ANN generator happened to return.
    const lexicalId = collectionStorageKey(collectionId, settings);
    let bm25Results = searchLexicalIndex(lexicalId, searchText, expandedTopK, {
        k1: settings.bm25_k1 || 1.5,
        b: settings.bm25_b || 0.75
    });
    // Read legacy bare-ID indexes until the collection is next written and
    // migrated to its collision-safe physical key.
    if (loadLexicalIndex(lexicalId).documentCount === 0) {
        bm25Results = searchLexicalIndex(collectionId, searchText, expandedTopK, {
            k1: settings.bm25_k1 || 1.5,
            b: settings.bm25_b || 0.75
        });
    }
    // Existing collections created before the index was introduced remain
    // searchable until their next vectorization builds the complete index.
    if (loadLexicalIndex(lexicalId).documentCount === 0 && loadLexicalIndex(collectionId).documentCount === 0 && vectorResults.metadata.length) {
        const denseDocuments = vectorResults.metadata.map((meta, idx) => ({
            hash: vectorResults.hashes[idx], text: meta.text || '', score: meta.score || 0, metadata: meta
        }));
        bm25Results = performBM25Search(denseDocuments, searchText, { k1: settings.bm25_k1, b: settings.bm25_b });
    }

    // 4. Fuse results
    let fusedResults;
    if (fusionMethod === 'rrf') {
        console.log(`[HybridSearch] Applying RRF fusion (k=${rrfK})...`);
        fusedResults = reciprocalRankFusion(
            [vectorResultsToRanked(vectorResults), bm25Results],
            rrfK
        );
    } else if (fusionMethod === 'heuristic_weighted') {
        console.log('[HybridSearch] Applying legacy heuristic-weighted fusion...');
        fusedResults = heuristicWeightedFusion(
            [vectorResultsToRanked(vectorResults), bm25Results],
            rrfK,
            heuristicSettings
        );
    } else if (fusionMethod === 'weighted') {
        console.log(`[HybridSearch] Applying weighted fusion (α=${vectorWeight}, β=${textWeight})...`);
        fusedResults = weightedCombination(
            vectorResultsToScored(vectorResults),
            bm25Results,
            vectorWeight,
            textWeight
        );
    } else {
        throw new Error(`Unsupported hybrid fusion method: ${fusionMethod}`);
    }

    // 5. Return top K fused results
    const topResults = fusedResults.slice(0, topK);
    const finalScore = result => fusionMethod === 'rrf' ? result.rrfScore : result.combinedScore;

    console.log(`[HybridSearch] Returning ${topResults.length} fused results`);
    if (topResults.length > 0) {
        // Log score distribution for debugging
        const scores = topResults.map(r => finalScore(r) || 0);
        console.log(`[HybridSearch] Score distribution: min=${Math.min(...scores).toFixed(4)}, max=${Math.max(...scores).toFixed(4)}`);
        console.log(`[HybridSearch] Top 3 results:`);
        topResults.slice(0, 3).forEach((r, i) => {
            const score = (finalScore(r) || 0).toFixed(4);
            const vRank = r.ranks?.vector || 'N/A';
            const tRank = r.ranks?.text || 'N/A';
            const vScore = (r.vectorScore || 0).toFixed(4);
            const tScore = (r.textScore || r.bm25Score || 0).toFixed(4);
            console.log(`  [${i + 1}] finalScore=${score}, vectorRank=${vRank}, textRank=${tRank}, vectorScore=${vScore}, textScore=${tScore}`);
        });
    }

    return {
        hashes: topResults.map(r => r.result?.hash ?? r.hash),
        metadata: topResults.map(r => ({
            ...(r.result?.metadata || r.metadata || {}),
            text: r.result?.text ?? r.text,
            hash: r.result?.hash ?? r.hash,
            score: finalScore(r) ?? 0,
            vectorScore: r.vectorScore ?? 0,
            textScore: r.textScore ?? r.bm25Score ?? 0,
            normalizedVectorScore: r.normalizedVectorScore,
            normalizedTextScore: r.normalizedTextScore,
            vectorRank: r.ranks?.vector,
            textRank: r.ranks?.text,
            fusionMethod: fusionMethod,
            hybridSearch: true,
            explain: {
                retrieval: 'hybrid',
                fusionMethod,
                vectorScore: r.vectorScore ?? 0,
                textScore: r.textScore ?? r.bm25Score ?? 0,
                vectorRank: r.ranks?.vector,
                textRank: r.ranks?.text,
                normalizedVectorScore: r.normalizedVectorScore,
                normalizedTextScore: r.normalizedTextScore,
                finalScore: finalScore(r) ?? 0
            }
        }))
    };
}

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
 * @returns {Array} Fused and sorted results with normalized scores
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

    // Convert to array and sort by raw RRF score
    const sortedResults = Array.from(fusedScores.values())
        .sort((a, b) => b.rawRrfScore - a.rawRrfScore || compareHashes(a.result.hash, b.result.hash));

    // RRF determines ORDER, but display scores should reflect actual similarity
    // This ensures chunks with high semantic match show high %, while chunks that
    // are just highly ranked but don't match well show appropriately lower %
    if (sortedResults.length > 0) {
        const maxRrfScore = sortedResults[0].rawRrfScore;

        // BM25 scores are unbounded (typically 0 to 10+)
        // Use saturation function to normalize: score / (score + k)
        // This gives intuitive 0-1 values: 0→0%, k→50%, 2k→67%, etc.
        const BM25_SATURATION_K = 3.0; // Score of 3 = 50%, score of 6 = 67%, etc.

        for (const entry of sortedResults) {
            // Calculate RRF rank factor (1.0 for top, decreasing for lower)
            const rrfRankFactor = maxRrfScore > 0 ? entry.rawRrfScore / maxRrfScore : 0;

            // vectorScore: cosine similarity (already 0-1)
            const vectorScore = entry.vectorScore || 0;

            // Normalize BM25 using saturation function (independent of batch)
            const rawBM25 = entry.textScore || 0;
            const normalizedTextScore = rawBM25 / (rawBM25 + BM25_SATURATION_K);

            // Update textScore for display consistency
            entry.textScore = normalizedTextScore;

            const hasVector = vectorScore > 0.01;
            const hasText = normalizedTextScore > 0.01;

            if (hasVector && hasText) {
                // Both signals present - weighted average
                const combinedScore = (vectorScore * 0.55 + normalizedTextScore * 0.45);
                // Small boost (up to 8%) for having both signals
                const dualSignalBonus = 1.0 + (Math.min(vectorScore, normalizedTextScore) * 0.08);
                entry.rrfScore = Math.min(1.0, combinedScore * dualSignalBonus * (0.95 + 0.05 * rrfRankFactor));
            } else if (hasVector) {
                // Vector-only: penalize since no keyword overlap suggests lower relevance
                entry.rrfScore = vectorScore * 0.55 * (0.9 + 0.1 * rrfRankFactor);
            } else if (hasText) {
                // Text-only: decent relevance but missing semantic similarity
                entry.rrfScore = normalizedTextScore * 0.6 * (0.9 + 0.1 * rrfRankFactor);
            } else {
                // Fallback: pure RRF rank - very low confidence
                entry.rrfScore = rrfRankFactor * 0.25;
            }

            // Ensure score never exceeds 1.0
            entry.rrfScore = Math.min(1.0, entry.rrfScore);
        }

        // Re-sort by final score (may differ slightly from raw RRF order)
        sortedResults.sort((a, b) => b.rrfScore - a.rrfScore || compareHashes(a.result.hash, b.result.hash));
    }

    return sortedResults;
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
    // Use query-independent transforms. Per-query min/max normalization makes
    // scores unstable and exaggerates narrow result distributions.
    const normalizedVector = normalizeScores(vectorResults, 'score', 'bounded');
    const normalizedText = normalizeScores(textResults, 'bm25Score', 'saturating');

    const combined = new Map();

    // Add all vector results
    for (const r of normalizedVector) {
        if (r.hash === undefined || r.hash === null) continue;

        combined.set(r.hash, {
            result: r,
            hash: r.hash,
            text: r.text,
            metadata: r.metadata,
            vectorScore: r.normalizedScore,
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
            entry.textScore = r.normalizedScore;
            entry.normalizedTextScore = r.normalizedScore;
            entry.combinedScore += beta * r.normalizedScore;
        } else {
            combined.set(r.hash, {
                result: r,
                hash: r.hash,
                text: r.text,
                metadata: r.metadata,
                vectorScore: 0,
                textScore: r.normalizedScore,
                normalizedVectorScore: 0,
                normalizedTextScore: r.normalizedScore,
                combinedScore: beta * r.normalizedScore
            });
        }
    }

    // Sort by combined score (descending)
    return Array.from(combined.values())
        .sort((a, b) => b.combinedScore - a.combinedScore || compareHashes(a.hash, b.hash));
}

function compareHashes(a, b) {
    return String(a).localeCompare(String(b));
}

/**
 * Min-max normalization of scores to [0, 1] range
 *
 * @param {Array} results - Results with scores
 * @param {string} scoreField - Field name containing the score
 * @returns {Array} Results with added normalizedScore field
 */
function normalizeScores(results, scoreField = 'score', method = 'bounded') {
    if (!results || results.length === 0) return [];

    return results.map(r => ({
        ...r,
        normalizedScore: method === 'saturating'
            ? Math.max(0, Number(r[scoreField]) || 0) / (Math.max(0, Number(r[scoreField]) || 0) + 3)
            : Math.max(0, Math.min(1, Number(r[scoreField]) || 0))
    }));
}

/**
 * Perform BM25 search on a result set
 *
 * @param {Array} results - Results to score [{hash, text, ...}]
 * @param {string} query - Search query
 * @param {object} options - BM25 options
 * @returns {Array} Results sorted by BM25 score
 */
function performBM25Search(results, query, options = {}) {
    if (!results || results.length === 0) return [];
    if (!query || typeof query !== 'string') {
        console.warn('[HybridSearch] Invalid query for BM25 search');
        return results;
    }

    const scorer = createBM25Scorer(results, options);
    if (!scorer || scorer.totalDocs === 0) {
        console.warn('[HybridSearch] Failed to create BM25 scorer or no documents indexed');
        return results;
    }

    // Get BM25 scores for all results
    const scoredResults = results.map((result, idx) => {
        const bm25Score = scorer.scoreDocument(tokenize(query, options), idx);
        return {
            ...result,
            bm25Score
        };
    });

    // Sort by BM25 score (descending)
    scoredResults.sort((a, b) => b.bm25Score - a.bm25Score);

    return scoredResults;
}

/**
 * Convert vector results to ranked format for RRF
 */
function vectorResultsToRanked(vectorResults) {
    return vectorResults.metadata.map((meta, idx) => ({
        hash: vectorResults.hashes[idx],
        score: meta.score || 0,
        text: meta.text || '',
        metadata: meta
    }));
}

/**
 * Convert vector results to scored format for weighted combination
 */
function vectorResultsToScored(vectorResults) {
    return vectorResultsToRanked(vectorResults);
}
