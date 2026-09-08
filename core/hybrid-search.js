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

import {
    DEFAULT_RRF_K, HEURISTIC_WEIGHTED_DEFAULTS, heuristicWeightedFusion,
    reciprocalRankFusion, weightedCombination
} from './fusion-algorithms.js';
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

    let vectorResults;
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
        return { hashes: [], metadata: [] };
    }

    if (!vectorResults || !vectorResults.metadata || vectorResults.metadata.length === 0) {
        console.log('[HybridSearch] No vector results found');
        console.log(`[HybridSearch] Debug - vectorResults:`, JSON.stringify(vectorResults));
        return { hashes: [], metadata: [] };
    }

    // 2. Convert to format for BM25 scoring (include title and tags for field boosting)
    const resultsWithText = vectorResults.metadata.map((meta, idx) => ({
        hash: vectorResults.hashes[idx],
        text: meta.text || '',
        title: meta.entryName || meta.title || '',
        tags: meta.keywords || [],
        score: meta.score || 0,
        metadata: meta
    }));

    // 3. Perform BM25 full-text search over the result set with field boosting
    console.log(`[HybridSearch] Computing BM25 scores for ${resultsWithText.length} results...`);
    const bm25Results = performBM25Search(resultsWithText, searchText, {
        k1: settings.bm25_k1 || 1.5,
        b: settings.bm25_b || 0.75,
        fieldBoosting: true  // Enable title (3x) and tags (2x) boosting
    });

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

export { reciprocalRankFusion, heuristicWeightedFusion, weightedCombination } from './fusion-algorithms.js';

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
