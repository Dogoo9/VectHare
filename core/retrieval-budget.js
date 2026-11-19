/**
 * Resolve the three independent retrieval budgets used by the chat pipeline.
 * `finalK` is an output cap; it must never be used as the initial fetch limit.
 */
export function resolveRetrievalBudgets(settings = {}) {
    const finalK = Math.max(1, Math.trunc(settings.final_k ?? settings.top_k ?? settings.insert ?? 3));
    const candidateKMax = Math.max(finalK, Math.trunc(settings.candidate_k_max ?? 500));
    const adaptiveCandidateK = Math.max(finalK * 4, finalK + 20);
    const candidateK = Math.min(candidateKMax, Math.max(finalK, Math.trunc(settings.candidate_k ?? adaptiveCandidateK)));
    const rerankK = Math.min(candidateKMax, Math.max(finalK, Math.trunc(settings.rerank_k ?? candidateK)));

    return { candidateK, rerankK, finalK, candidateKMax };
}

function normalizedChunkText(chunk) {
    return String(chunk?.text ?? chunk?.metadata?.text ?? '').replace(/\s+/g, ' ').trim();
}

/** Estimated prompt cost of a chunk, at 4 characters per token. */
export function estimateChunkTokens(chunk) {
    return Math.ceil(String(chunk?.text ?? chunk?.metadata?.text ?? '').length / 4);
}

/** Entries named in the chat or story memory are never dropped to save tokens. */
export function isNamedChunk(chunk) {
    return Boolean(chunk?.keywordForceInjected || chunk?.memoryKeywordMatched);
}

/** Return every identity which proves that two hits are the same stored chunk. */
function chunkIdentityKeys(chunk) {
    const metadata = chunk?.metadata || {};
    const collectionId = String(chunk?.collectionId ?? metadata.collectionId ?? '');
    const keys = [];
    const hash = chunk?.hash ?? metadata.hash;
    if (hash !== undefined && hash !== null && hash !== '') keys.push(`hash:${collectionId}:${hash}`);

    // Identical content is a duplicate even when hashes differ (edited rows) or
    // when two collections hold the same entry.
    const text = normalizedChunkText(chunk);
    if (text) keys.push(`text:${text}`);

    // A source coordinate catches stale pre-edit and current post-edit rows.
    // Only use an index explicitly supplied in metadata; the retrieval layer's
    // synthesized index=0 fallback is not a safe identity.
    for (const field of ['chunkId', 'messageId']) {
        if (metadata[field] !== undefined && metadata[field] !== null && metadata[field] !== '') {
            keys.push(`source:${collectionId}:${field}:${metadata[field]}`);
            break;
        }
    }
    if (Object.prototype.hasOwnProperty.call(metadata, 'index') && metadata.index !== null) {
        keys.push(`source:${collectionId}:index:${metadata.index}`);
    }
    return keys;
}

/** Sort, remove duplicate backend rows, and enforce the output budget. */
export function selectFinalChunks(chunks, finalK, { maxTokens = 0 } = {}) {
    const ranked = [...chunks].sort((a, b) => {
        // Exact keyword activations are authoritative. Put them ahead of
        // semantic 100% ties so backend ordering cannot cost them a slot.
        const keywordPriority = Number(Boolean(b.keywordForceInjected)) - Number(Boolean(a.keywordForceInjected));
        const memoryPriority = Number(Boolean(b.memoryKeywordMatched)) - Number(Boolean(a.memoryKeywordMatched));
        return keywordPriority || memoryPriority || (b.score ?? 0) - (a.score ?? 0);
    });
    const selected = [];
    const seen = new Set();
    let tokens = 0;
    for (const chunk of ranked) {
        const identities = chunkIdentityKeys(chunk);
        if (identities.some(identity => seen.has(identity))) continue;
        const cost = estimateChunkTokens(chunk);
        if (maxTokens > 0 && !isNamedChunk(chunk) && tokens + cost > maxTokens) continue;
        tokens += cost;
        identities.forEach(identity => seen.add(identity));
        selected.push(chunk);
        if (selected.length >= finalK) break;
    }
    return selected;
}
