/**
 * Resolve the three independent retrieval budgets used by the chat pipeline.
 * `finalK` is an output cap; it must never be used as the initial fetch limit.
 */
export function resolveRetrievalBudgets(settings = {}) {
    const finalK = Math.max(1, Math.trunc(settings.final_k ?? settings.top_k ?? settings.insert ?? 3));
    const candidateKMax = Math.max(finalK, Math.trunc(settings.candidate_k_max ?? 200));
    const adaptiveCandidateK = Math.max(finalK * 4, finalK + 20);
    const candidateK = Math.min(candidateKMax, Math.max(finalK, Math.trunc(settings.candidate_k ?? adaptiveCandidateK)));
    const rerankK = Math.min(candidateKMax, Math.max(finalK, Math.trunc(settings.rerank_k ?? candidateK)));

    return { candidateK, rerankK, finalK, candidateKMax };
}

/** Increase a candidate request geometrically without exceeding its cost cap. */
export function nextCandidateK(current, maximum) {
    return Math.min(maximum, Math.max(current + 1, current * 2));
}

/** Sort and enforce the output budget only after every ranking stage has run. */
export function selectFinalChunks(chunks, finalK) {
    return [...chunks].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, finalK);
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
