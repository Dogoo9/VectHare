/**
 * Cross-collection result fusion.
 *
 * Scores from unrelated indexes are not assumed to be comparable. Ranked lists
 * are fused with weighted RRF and retain the evidence needed to explain every
 * decision. Calibrated score merging is deliberately opt-in and requires an
 * evaluation-backed calibration descriptor on every collection.
 */

export const COLLECTION_RRF_K = 60;

const DEFAULT_SOURCE_PRIORITIES = {
    current_chat: 400,
    character_memory: 300,
    lorebook: 200,
    external_document: 100,
    unknown: 0,
};

function finite(value, fallback = 0) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

export function embeddingSpaceKey(embedding = {}) {
    const { provider, modelId, dimension, distanceMetric, indexVersion } = embedding;
    if (!provider || !modelId || !dimension || !distanceMetric || !indexVersion) return null;
    return [provider, modelId, dimension, distanceMetric, indexVersion].map(String).join('|');
}

export function areEmbeddingSpacesCompatible(left, right) {
    const a = embeddingSpaceKey(left);
    const b = embeddingSpaceKey(right);
    return a !== null && b !== null && a === b;
}

function stableId(result) {
    return String(result.stableChunkId ?? result.hash ?? result.metadata?.chunkId ?? '');
}

function compareResults(a, b) {
    return finite(b.fusedScore) - finite(a.fusedScore)
        || finite(b.rerankerScore, -Infinity) - finite(a.rerankerScore, -Infinity)
        || finite(b.sourcePriority) - finite(a.sourcePriority)
        || finite(b.recencyOrAuthority) - finite(a.recencyOrAuthority)
        || stableId(a).localeCompare(stableId(b));
}

function sourcePriority(collection, priorities) {
    return finite(collection.sourcePriority,
        priorities[collection.collectionType] ?? priorities.unknown ?? 0);
}

function preserveResult(result, collection, rank, fusedScore, contribution, priorities) {
    const metadata = result.metadata || {};
    const subScores = {
        lexical: result.lexicalScore ?? result.textScore ?? metadata.lexicalScore ?? metadata.textScore,
        vector: result.vectorScore ?? metadata.vectorScore ?? result.score,
        reranker: result.rerankerScore ?? metadata.rerankerScore,
    };
    const rawBackendScore = result.rawBackendScore ?? metadata.rawBackendScore
        ?? metadata.originalScore ?? result.originalScore ?? result.score;
    return {
        ...result,
        score: fusedScore,
        fusedScore,
        rawBackendScore,
        withinCollectionRank: rank,
        retrievalMethod: result.retrievalMethod ?? metadata.explain?.retrieval ?? metadata.retrievalMethod ?? 'vector',
        embedding: { ...(collection.embedding || {}) },
        collectionId: collection.collectionId,
        collectionSize: collection.collectionSize ?? null,
        collectionType: collection.collectionType ?? 'unknown',
        collectionWeight: finite(collection.weight, 1),
        sourcePriority: sourcePriority(collection, priorities),
        rerankerScore: subScores.reranker,
        recencyOrAuthority: result.recencyOrAuthority ?? metadata.authority ?? metadata.timestamp ?? 0,
        stableChunkId: stableId(result),
        subScores,
        fusionContribution: contribution,
        fusionMethod: 'weighted_rrf',
        metadata: {
            ...metadata,
            rawBackendScore,
            fusedScore,
            withinCollectionRank: rank,
            retrievalMethod: result.retrievalMethod ?? metadata.explain?.retrieval ?? metadata.retrievalMethod ?? 'vector',
            embedding: { ...(collection.embedding || {}) },
            collectionSize: collection.collectionSize ?? null,
            collectionType: collection.collectionType ?? 'unknown',
            subScores,
        },
    };
}

/** Fuse independently-ranked collection result lists using weighted RRF. */
export function fuseCollectionResults(collections, options = {}) {
    const k = finite(options.rrfK, COLLECTION_RRF_K);
    const priorities = { ...DEFAULT_SOURCE_PRIORITIES, ...(options.sourcePriorities || {}) };
    const fused = [];
    const spaces = new Set();

    for (const collection of collections || []) {
        const space = embeddingSpaceKey(collection.embedding);
        if (space) spaces.add(space);
        const weight = Math.max(0, finite(collection.weight, 1));
        (collection.results || []).forEach((result, offset) => {
            const rank = offset + 1;
            const contribution = weight / (k + rank);
            fused.push(preserveResult(result, collection, rank, contribution, contribution, priorities));
        });
    }

    // Weighted RRF compares ranks, not vector magnitudes, so different known
    // spaces remain isolated at the score level. Unknown identity is surfaced.
    fused.sort(compareResults);
    return {
        results: fused,
        method: 'weighted_rrf',
        heterogeneous: spaces.size > 1,
        embeddingSpaces: [...spaces],
        hasUnknownEmbeddingSpace: (collections || []).some(c => !embeddingSpaceKey(c.embedding)),
    };
}

/**
 * Merge scores only when all collections share a space and carry evaluation
 * backed calibration. Callers must explicitly request this mode.
 */
export function mergeCalibratedCollectionResults(collections, options = {}) {
    if (options.enabled !== true) throw new Error('Calibrated merging must be explicitly enabled');
    const keys = (collections || []).map(c => embeddingSpaceKey(c.embedding));
    if (!keys.length || keys.some(key => !key) || new Set(keys).size !== 1) {
        throw new Error('Cannot compare results from incompatible or unknown embedding spaces');
    }
    if (collections.some(c => !c.calibration?.evaluationId || typeof c.calibration?.transform !== 'function')) {
        throw new Error('Calibrated merging requires evaluation data and a calibration transform');
    }

    const priorities = { ...DEFAULT_SOURCE_PRIORITIES, ...(options.sourcePriorities || {}) };
    const results = collections.flatMap(collection => (collection.results || []).map((result, offset) => {
        const raw = result.rawBackendScore ?? result.metadata?.rawBackendScore ?? result.score;
        const calibrated = collection.calibration.transform(raw);
        return preserveResult(result, collection, offset + 1, calibrated, calibrated, priorities);
    }));
    results.forEach(result => { result.fusionMethod = 'calibrated_score'; });
    results.sort(compareResults);
    return { results, method: 'calibrated_score', heterogeneous: false, embeddingSpaces: [keys[0]] };
}
