export const EMBEDDING_FINGERPRINT_VERSION = 1;
export const PROBE_TOLERANCE = 1e-5;

const FINGERPRINT_FIELDS = [
    'artifact', 'revision', 'dimension', 'pooling', 'normalization',
    'documentPrefix', 'queryPrefix', 'documentTask', 'queryTask',
    'tokenizer', 'truncation', 'maxTokens', 'distanceMetric',
];

/** A credential-free description of an embedding space, not of its server. */
export function createEmbeddingFingerprint(value = {}) {
    const fingerprint = { version: EMBEDDING_FINGERPRINT_VERSION };
    for (const field of FINGERPRINT_FIELDS) {
        if (value[field] !== undefined && value[field] !== null && value[field] !== '') {
            fingerprint[field] = value[field];
        }
    }
    return fingerprint;
}

export function fingerprintKey(value) {
    const fingerprint = createEmbeddingFingerprint(value);
    return JSON.stringify(Object.fromEntries(Object.entries(fingerprint).sort(([a], [b]) => a.localeCompare(b))));
}

/** Missing provenance is unknown; matching names or dimensions never certify compatibility. */
export function compareEmbeddingFingerprints(stored, candidate) {
    const left = createEmbeddingFingerprint(stored);
    const right = createEmbeddingFingerprint(candidate);
    const identity = ['artifact', 'revision'];
    if (!identity.some(field => left[field] && right[field])) {
        return { status: 'unknown', reason: 'The stored vectors have no trustworthy artifact or revision provenance.' };
    }
    const mismatches = FINGERPRINT_FIELDS.filter(field =>
        left[field] !== undefined && right[field] !== undefined && left[field] !== right[field]);
    if (mismatches.length) {
        return { status: 'incompatible', reason: `Embedding fingerprint differs: ${mismatches.join(', ')}`, mismatches };
    }
    const missing = FINGERPRINT_FIELDS.filter(field => left[field] === undefined || right[field] === undefined);
    if (missing.length) {
        return { status: 'unknown', reason: `Compatibility cannot be verified; missing: ${missing.join(', ')}`, missing };
    }
    return { status: 'compatible', reason: 'Versioned embedding fingerprints match.' };
}

function validVector(vector, dimension) {
    return Array.isArray(vector) && vector.length > 0 && (!dimension || vector.length === dimension) &&
        vector.every(Number.isFinite) && vector.some(value => value !== 0);
}

/** Compare synthetic public document and query probes. Agreement is evidence, not a guarantee. */
export function compareEmbeddingProbes(stored, candidate, dimension, tolerance = PROBE_TOLERANCE) {
    for (const mode of ['document', 'query']) {
        const a = stored?.[mode];
        const b = candidate?.[mode];
        if (!validVector(a, dimension) || !validVector(b, dimension)) {
            return { status: 'unknown', reason: `Invalid, zero, non-finite, or wrong-dimension ${mode} probe.` };
        }
        if (a.length !== b.length) return { status: 'incompatible', reason: `${mode} probe dimensions differ.` };
        const maxError = Math.max(...a.map((value, index) => Math.abs(value - b[index])));
        if (maxError > tolerance) {
            return { status: 'incompatible', reason: `${mode} probe exceeds tolerance (${maxError} > ${tolerance}).`, maxError };
        }
    }
    return { status: 'compatible', reason: `Synthetic document and query probes agree within ${tolerance}; this is evidence, not a mathematical guarantee.` };
}

/** Physical routing remains frozen while connection settings may change. */
export function storageSettings(settings = {}) {
    const locator = settings.collection_locator || settings.storageLocator;
    if (!locator) return settings;
    return {
        ...settings,
        vector_backend: locator.backend || settings.vector_backend,
        source: locator.source || settings.source,
        model: locator.model ?? settings.model,
        collection_locator: locator,
    };
}

export function collectionStorageKey(collectionId, settings = {}) {
    const locator = settings.collection_locator || settings.storageLocator || {};
    const parts = String(collectionId).split(':');
    const hasRegistryPrefix = parts.length >= 3 && ['standard', 'lancedb', 'vectra', 'milvus', 'qdrant'].includes(parts[0]);
    const parsed = hasRegistryPrefix
        ? { backend: parts[0], source: parts[1], collectionId: parts.slice(2).join(':') }
        : { collectionId };
    return [locator.backend || parsed.backend || settings.vector_backend || 'standard',
        locator.source || parsed.source || settings.source || 'transformers',
        locator.model || '', parsed.collectionId || collectionId].map(encodeURIComponent).join(':');
}

export function assertWritableEmbedding(settings = {}) {
    if (settings.embeddingCompatibility && settings.embeddingCompatibility !== 'compatible') {
        throw new Error(`Collection embedding connection is ${settings.embeddingCompatibility}; rebuild into a new collection before writing.`);
    }
}

/** Generic two-phase rebuild. The source is never mutated or deleted. */
export async function rebuildCollection({ source, target, items, writeBatch, verify, cleanupTarget, signal, batchSize = 50, onProgress }) {
    if (!source || !target || source === target) throw new Error('Rebuild requires a distinct target collection.');
    if (!Array.isArray(items) || items.some(item => typeof item?.text !== 'string' || !item.text.trim())) {
        throw new Error('Rebuild requires recoverable text for every chunk.');
    }
    let written = 0;
    try {
        for (let offset = 0; offset < items.length; offset += batchSize) {
            if (signal?.aborted) throw new DOMException('Rebuild cancelled', 'AbortError');
            const batch = items.slice(offset, offset + batchSize);
            await writeBatch(target, batch);
            written += batch.length;
            onProgress?.({ written, total: items.length, source, target });
        }
        if (signal?.aborted) throw new DOMException('Rebuild cancelled', 'AbortError');
        const verification = await verify(target, items);
        if (!verification?.ok) throw new Error(verification?.reason || 'Target verification failed.');
        return { status: 'ready', source, target, written, verification };
    } catch (error) {
        await cleanupTarget?.(target);
        error.rebuild = { status: 'rolled-back', source, target, written };
        throw error;
    }
}
