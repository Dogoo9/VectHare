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

/** Increase a candidate request geometrically without exceeding its cost cap. */
export function nextCandidateK(current, maximum) {
    return Math.min(maximum, Math.max(current + 1, current * 2));
}

function normalizedChunkText(chunk) {
    return String(chunk?.text ?? chunk?.metadata?.text ?? '').replace(/\s+/g, ' ').trim();
}

/** Return every identity which proves that two hits are the same stored chunk. */
function chunkIdentityKeys(chunk) {
    const metadata = chunk?.metadata || {};
    const collectionId = String(chunk?.collectionId ?? metadata.collectionId ?? '');
    const keys = [];
    const hash = chunk?.hash ?? metadata.hash;
    if (hash !== undefined && hash !== null && hash !== '') keys.push(`hash:${collectionId}:${hash}`);

    // Some backends re-hash a row while editing it, so identical content is
    // still a duplicate even when the returned hashes differ.
    const text = normalizedChunkText(chunk);
    if (text) keys.push(`text:${collectionId}:${text}`);

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
export function selectFinalChunks(chunks, finalK) {
    const ranked = [...chunks].sort((a, b) => {
        // Exact keyword activations are authoritative. Put them ahead of
        // semantic 100% ties so backend ordering cannot cost them a slot.
        const keywordPriority = Number(Boolean(b.keywordForceInjected)) - Number(Boolean(a.keywordForceInjected));
        return keywordPriority || (b.score ?? 0) - (a.score ?? 0);
    });
    const selected = [];
    const seen = new Set();
    for (const chunk of ranked) {
        const identities = chunkIdentityKeys(chunk);
        if (identities.some(identity => seen.has(identity))) continue;
        identities.forEach(identity => seen.add(identity));
        selected.push(chunk);
        if (selected.length >= finalK) break;
    }
    return selected;
}

/**
 * Backend-neutral adaptive refill primitive. A page is the complete top-N
 * prefix because current vector backends expose a limit rather than a cursor.
 */
export async function collectAdaptiveCandidates(fetchPrefix, hardFilter, budgets) {
    let requestK = budgets.candidateK;
    let eligible = [];

    while (true) {
        const candidates = await fetchPrefix(requestK);
        eligible = await hardFilter(candidates);
        const exhausted = candidates.length < requestK;
        if (eligible.length >= budgets.finalK || exhausted || requestK >= budgets.candidateKMax) return eligible;
        requestK = nextCandidateK(requestK, budgets.candidateKMax);
    }
}
