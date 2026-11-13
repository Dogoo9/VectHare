/**
 * ============================================================================
 * CORE VECTOR API CLIENT
 * ============================================================================
 * Abstraction layer for vector operations.
 * Routes to different backends: ST's Vectra API, LanceDB, or Qdrant.
 *
 * Functions:
 * - getVectorsRequestBody() - Builds request body for embedding providers
 * - getAdditionalArgs() - Special handling for WebLLM/KoboldCpp
 * - throwIfSourceInvalid() - Validates provider configuration
 * - getSavedHashes() - GET existing hashes from a collection
 * - insertVectorItems() - POST embeddings to backend
 * - queryCollection() - POST query to find similar vectors
 * - queryMultipleCollections() - POST query across multiple collections
 * - deleteVectorItems() - DELETE specific hashes
 * - purgeVectorIndex() - DELETE entire collection
 * - purgeAllVectorIndexes() - DELETE all collections
 * - purgeFileVectorIndex() - DELETE file-specific collection
 *
 * @author Base: Cohee#1207 | VectHare: Backend abstraction
 * ============================================================================
 */

import '../../../../../script.js'; // side effects only
import { extension_settings, modules } from '../../../../extensions.js';
import { secret_state } from '../../../../secrets.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { oai_settings } from '../../../../openai.js';
import { isWebLlmSupported } from '../../../shared.js';
import { getWebLlmProvider } from '../providers/webllm.js';
import { getBackend, invalidateBackendHealth, recordQuery, recordInsert, recordDelete, recordError } from '../backends/backend-manager.js';
import {
    getProviderConfig,
    getModelField,
    getSecretKey,
    requiresApiKey,
    requiresUrl,
} from './providers.js';
import { applyKeywordBoosts, getOverfetchAmount } from './keyword-boost.js';
import { applyBM25Scoring } from './bm25-scorer.js';
import { hybridSearch } from './hybrid-search.js';
import { indexLexicalItems, deleteLexicalItems, purgeLexicalIndex, searchLexicalIndex } from './lexical-index.js';
import { assertWritableEmbedding, collectionStorageKey, storageSettings } from './collection-portability.js';
import { embedLocal } from '../providers/local-embeddings.js';
import { resolveCollectionSettings, physicalCollectionId, embeddingProfileKey, collectionMutation } from './collection-runtime.js';
import { getStorageHashes } from './storage-hashes.js';
import { completeLexicalCoverage } from './lexical-index.js';
import AsyncUtils from '../utils/async-utils.js';
import StringUtils from '../utils/string-utils.js';
import {
    API_TIMEOUT_MS,
    RETRY_MAX_ATTEMPTS,
    RETRY_INITIAL_DELAY_MS,
    RETRY_MAX_DELAY_MS,
    RETRY_BACKOFF_MULTIPLIER,
} from './constants.js';
import { pluginRequest } from '../backends/similharity-backend.js';
import { logger } from '../utils/logger.js';

// Get shared WebLLM provider singleton (lazy-initialized)
const webllmProvider = getWebLlmProvider();

function usesClientEmbeddings(settings) {
    return ['webllm', 'koboldcpp', 'bananabread'].includes(settings.source) || !!settings.local_embedding_profile;
}

function requirePrecomputedForReassignment(settings, routed, vector = null, backend = null) {
    if (vector && (routed.vector_backend || 'standard') === 'standard' && !backend?.pluginAvailable && !['koboldcpp', 'webllm'].includes(routed.source)) {
        throw new Error('Native SillyTavern only consumes precomputed vectors in koboldcpp/webllm namespaces. Rebuild into a new webllm namespace or install the documented upstream API enhancement.');
    }
    if (routed.source !== settings.source && !vector) {
        throw new Error('This embedding reassignment requires companion-server support for precomputed vectors with an independent storage namespace. Use lexical-only retrieval or rebuild instead.');
    }
}

/** Storage-routed settings carrying the server-side embedding request args. */
function routedSettings(settings) {
    const serverEmbeds = !usesClientEmbeddings(settings) && settings.retrieval_mode !== 'lexical_only';
    return storageSettings({ ...settings, inference_request_args: serverEmbeds ? getVectorsRequestBody({}, settings) : {} });
}

/**
 * Embeds the query in the browser for client-side sources. Returns null when
 * the backend embeds server-side. A failed client embedding must not fall back
 * to another inference provider, so it throws.
 * @returns {Promise<number[]|null>}
 */
async function embedQueryVector(searchText, settings) {
    if (!usesClientEmbeddings(settings)) return null;
    const additionalArgs = await getAdditionalArgs([searchText], settings, null, 'query');
    const vector = additionalArgs.embeddings?.[searchText];
    if (!vector) throw new Error('Client embedding returned no query vector.');
    return vector;
}

/** Lexical-only search result for one collection. */
function lexicalResult(collectionId, searchText, topK, settings) {
    const matches = searchLexicalIndex(collectionStorageKey(collectionId, settings), searchText, topK);
    return {
        hashes: matches.map(item => item.hash),
        metadata: matches.map(item => ({ ...item.metadata, bm25Score: item.bm25Score, retrievalMode: 'lexical-only', score: undefined })),
    };
}

/** Applies keyword/BM25 scoring to raw backend results and returns { hashes, metadata }. */
function scoreBackendResults(rawResults, searchText, topK, settings, overfetchAmount) {
    const resultsForBoost = rawResults.metadata.map((meta, idx) => ({
        hash: meta.hash || rawResults.hashes[idx],
        score: meta.score || 0,
        metadata: meta,
        text: meta.text || '',
    }));
    const finalResults = scoreResults(resultsForBoost, searchText, topK, settings, overfetchAmount);
    return {
        hashes: finalResults.map(r => r.hash),
        metadata: finalResults.map(r => ({
            ...r.metadata,
            score: r.score,
            originalScore: r.originalScore || r.vectorScore,
            keywordBoost: r.keywordBoost,
            bm25Score: r.bm25Score,
            normalizedBM25: r.normalizedBM25,
            vectorScore: r.vectorScore,
            matchedKeywords: r.matchedKeywords,
            matchedKeywordsWithWeights: r.matchedKeywordsWithWeights,
            keywordBoosted: r.keywordBoosted,
            explain: {
                retrieval: 'vector',
                vectorScore: r.vectorScore ?? r.originalScore ?? r.score,
                keywordBoost: r.keywordBoost ?? 1,
                keywordBoostConfidence: r.keywordBoostConfidence ?? 0,
                keywordOverlapRatio: r.keywordOverlapRatio ?? 0,
                matchedKeywords: r.matchedKeywords || [],
                finalScore: r.score,
            },
        })),
    };
}

/**
 * VEC-33: Wrapper for backend operations that invalidates health cache on error
 * @param {Function} operation - Async function that performs the backend operation
 * @param {object} settings - Settings object (used to determine backend name)
 * @returns {Promise<any>} Result of the operation
 * @throws {Error} Re-throws the original error after invalidating cache
 */
async function withHealthInvalidation(operation, settings) {
    try {
        return await operation();
    } catch (error) {
        // Invalidate health cache for the backend that failed
        const backendName = settings?.vector_backend || 'standard';
        invalidateBackendHealth(backendName, error);
        throw error;
    }
}

/**
 * Rate limiter that respects user settings dynamically.
 */
class DynamicRateLimiter {
    constructor() {
        this.timestamps = [];
    }

    /**
     * Executes a function if rate limits allow, or waits until they do.
     * @param {Function} fn Function to execute
     * @param {object} settings Settings containing rate_limit_calls and rate_limit_interval
     * @returns {Promise<any>} Result of the function
     */
    async execute(fn, settings) {
        const maxCalls = settings.rate_limit_calls || 0; // 0 = disabled
        const intervalMs = (settings.rate_limit_interval || 60) * 1000;

        if (maxCalls <= 0) {
            return await fn();
        }

        // Clean up old timestamps
        const now = Date.now();
        this.timestamps = this.timestamps.filter(t => now - t < intervalMs);

        if (this.timestamps.length >= maxCalls) {
            // Calculate wait time
            const oldest = this.timestamps[0];
            const waitTime = (oldest + intervalMs) - now;

            if (waitTime > 0) {
                logger.debug(`VectHare: Rate limit reached. Waiting ${Math.round(waitTime / 1000)}s...`);
                await AsyncUtils.sleep(waitTime + 100); // Add small buffer
            }

            // Recursive call to re-check
            return this.execute(fn, settings);
        }

        // Add timestamp and execute
        this.timestamps.push(Date.now());
        return await fn();
    }
}

// Global rate limiter instance
const dynamicRateLimiter = new DynamicRateLimiter();

/**
 * Helper to batch array into chunks
 * @template T
 * @param {T[]} array
 * @param {number} size
 * @returns {T[][]}
 */
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

/**
 * True for transient failures worth retrying: network errors, timeouts, rate
 * limits and 502/503/504. Other HTTP errors (400, 401, 404, 500...) fail fast.
 * @param {Error} error
 * @returns {boolean}
 */
export function isRetryableError(error) {
    const message = error?.message?.toLowerCase() || '';
    // Browser network failures surface as TypeError ("Failed to fetch",
    // "NetworkError when attempting...", "Load failed").
    if (error?.name === 'TypeError' && /fetch|network|load failed/.test(message)) return true;
    if (/^(failed to fetch|load failed)$/.test(message)) return true;
    return /network ?error|timed? ?out|timeout|econnreset|econnrefused|suspended|rate limit|too many requests|\b(429|502|503|504)\b/.test(message);
}

// Retry configuration for transient failures (matches AsyncUtils.retry signature)
const RETRY_CONFIG = {
    maxAttempts: RETRY_MAX_ATTEMPTS,
    delay: RETRY_INITIAL_DELAY_MS,
    maxDelay: RETRY_MAX_DELAY_MS,
    backoffFactor: RETRY_BACKOFF_MULTIPLIER,
    shouldRetry: isRetryableError,
};

/**
 * Strips HTML and Markdown formatting from text before embedding.
 * Uses StringUtils from ST-Helpers for consistent text cleaning.
 * @param {string} text - Text to clean
 * @returns {string} Cleaned text
 */
function stripFormatting(text) {
    if (!text || typeof text !== 'string') {
        return text;
    }
    // Strip HTML first, then Markdown
    let cleaned = StringUtils.stripHtml(text, true);
    cleaned = StringUtils.stripMarkdown(cleaned);
    return cleaned.trim();
}

/**
 * Gets common body parameters for vector requests.
 * @param {object} args Additional arguments
 * @param {object} settings VectHare settings object
 * @returns {object} Request body
 */
export function getVectorsRequestBody(args = {}, settings) {
    const body = Object.assign({}, args);
    switch (settings.source) {
        case 'extras':
            body.extrasUrl = extension_settings.apiUrl;
            body.extrasKey = extension_settings.apiKey;
            break;
        case 'electronhub':
            body.model = settings.electronhub_model;
            break;
        case 'openrouter':
            body.model = settings.openrouter_model;
            break;
        case 'togetherai':
            body.model = settings.togetherai_model;
            break;
        case 'openai':
            body.model = settings.openai_model;
            break;
        case 'cohere':
            body.model = settings.cohere_model;
            break;
        case 'ollama':
            body.model = settings.ollama_model;
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.OLLAMA];
            body.keep = !!settings.ollama_keep;
            break;
        case 'llamacpp': {
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls?.[textgen_types.LLAMACPP];
            // Companion backends resolve an omitted URL on the server. Requiring
            // the browser's text-generation URL here breaks their default endpoint
            // on clients where that connection has never been configured.
            const backend = storageSettings(settings).vector_backend;
            const usesServerDefault = ['qdrant', 'lancedb', 'milvus'].includes(backend);
            if (!body.apiUrl && (settings.use_alt_endpoint || !usesServerDefault)) {
                throw new Error('Configure the llama.cpp embedding server URL in SillyTavern or VectHare alternate endpoint settings.');
            }
            break;
        }
        case 'vllm':
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.VLLM];
            body.model = settings.vllm_model;
            break;
        case 'bananabread':
            body.apiUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
            // Use extension settings for API key (custom keys aren't returned by ST's readSecretState)
            if (settings.bananabread_api_key) {
                body.apiKey = settings.bananabread_api_key;
            }
            break;
        case 'webllm':
            body.model = settings.webllm_model;
            break;
        case 'palm':
            body.model = settings.google_model;
            body.api = 'makersuite';
            break;
        case 'vertexai':
            body.model = settings.google_model;
            body.api = 'vertexai';
            body.vertexai_auth_mode = oai_settings.vertexai_auth_mode;
            body.vertexai_region = oai_settings.vertexai_region;
            body.vertexai_express_project_id = oai_settings.vertexai_express_project_id;
            break;
        default:
            break;
    }
    return body;
}

/**
 * Gets additional arguments for embeddings.
 * For client-side providers (webllm, koboldcpp, bananabread), this generates embeddings.
 * @param {string[]} items Items to embed
 * @param {object} settings VectHare settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<object>} Additional arguments
 */
export function configuredLocalEmbeddingProfile(settings, source, embedding) {
    if (!['koboldcpp', 'llamacpp'].includes(source)) return null;
    const type = source === 'koboldcpp' ? textgen_types.KOBOLDCPP : textgen_types.LLAMACPP;
    const endpoint = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[type];
    if (!endpoint) return null;
    return { source, endpoint, model: settings[`${source}_model`] || source,
        fingerprint: embedding.fingerprint, probes: embedding.probes };
}

export async function getAdditionalArgs(items, settings, onProgress = null, mode = 'document') {
    if (settings.local_embedding_profile) {
        const profile = { ...settings.local_embedding_profile, apiKey: settings.local_embedding_api_key };
        const cleaned = profile.fingerprint?.textCleaning === 'strip-markdown-html' ? items.map(t => stripFormatting(t) || t) : items;
        const result = await embedLocal(cleaned, profile, { mode, signal: settings.embedding_signal, onProgress });
        return { embeddings: Object.fromEntries(items.map((t, i) => [t, result.vectors[i]])), model: result.model };
    }
    const args = {};
    switch (settings.source) {
        case 'webllm':
            args.embeddings = await createWebLlmEmbeddings(items, settings);
            break;
        case 'koboldcpp': {
            const { embeddings, model } = await createKoboldCppEmbeddings(items, settings, onProgress);
            args.embeddings = embeddings;
            args.model = model;
            break;
        }
        case 'bananabread': {
            const { embeddings, model } = await createBananaBreadEmbeddings(items, settings);
            args.embeddings = embeddings;
            args.model = model;
            break;
        }
    }
    return args;
}

/**
 * Creates WebLLM embeddings for a list of items.
 * Wrapped with retry and timeout for robustness.
 * @param {string[]} items Items to embed
 * @param {object} settings VectHare settings object
 * @returns {Promise<Record<string, number[]>>} Calculated embeddings
 */
async function createWebLlmEmbeddings(items, settings) {
    if (items.length === 0) {
        return /** @type {Record<string, number[]>} */ ({});
    }

    if (!isWebLlmSupported()) {
        throw new Error('VectHare: WebLLM is not supported', { cause: 'webllm_not_supported' });
    }

    // Clean text before embedding
    const cleanedItems = items.map(item => stripFormatting(item) || item);

    return await AsyncUtils.retry(async () => {
        const embedPromise = webllmProvider.embedTexts(cleanedItems, settings.webllm_model);
        const embeddings = await AsyncUtils.timeout(embedPromise, API_TIMEOUT_MS * 2, 'WebLLM embedding request timed out');

        const result = /** @type {Record<string, number[]>} */ ({});
        for (let i = 0; i < items.length; i++) {
            // Map back to original items for hash consistency
            result[items[i]] = embeddings[i];
        }
        return result;
    }, {
        ...RETRY_CONFIG,
        onRetry: (attempt, error) => {
            console.warn(`VectHare: WebLLM embedding retry ${attempt} - ${error.message}`);
        }
    });
}

/**
 * Creates KoboldCpp embeddings for a list of items.
 * Wrapped with retry and rate limiting for robustness.
 * @param {string[]} items Items to embed
 * @param {object} settings VectHare settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<{embeddings: Record<string, number[]>, model: string}>} Calculated embeddings
 */
async function createKoboldCppEmbeddings(items, settings, onProgress = null) {
    const endpoint = settings.use_alt_endpoint ? settings.alt_endpoint_url : textgenerationwebui_settings.server_urls[textgen_types.KOBOLDCPP];
    const result = await dynamicRateLimiter.execute(() => embedLocal(items.map(t => stripFormatting(t) || t), {
        endpoint, model: settings.koboldcpp_model || 'koboldcpp', batchSize: 10,
    }, { onProgress, signal: settings.embedding_signal }), settings);
    return { embeddings: Object.fromEntries(items.map((t, i) => [t, result.vectors[i]])), model: result.model };
}

/**
 * Creates BananaBread embeddings for a list of items.
 * Wrapped with retry, timeout, and rate limiting for robustness.
 * @param {string[]} items Items to embed
 * @param {object} settings VectHare settings object
 * @returns {Promise<{embeddings: number[][], model: string}>} Calculated embeddings as array (index-aligned with input items)
 */
async function createBananaBreadEmbeddings(items, settings) {
    // Clean text before embedding (strip HTML/Markdown & Handle mixed types: strings vs objects)
    // Note: Must preserve 1:1 mapping with input items, so we replace empty strings with space instead of filtering
    const cleanedItems = items.map(item => {
        let text = '';
        // 1. Handle primitive strings
        if (typeof item === 'string') {
            text = stripFormatting(item) || item;
        }
        // 2. Handle objects: Extract known text fields (e.g., item.text, item.content)
        else if (item && typeof item === 'object') {
            const textValue = item.text || item.content || '';
            text = stripFormatting(textValue) || textValue;
        }

        // 3. Fallback for unexpected types or empty result
        return text.length > 0 ? text : ' ';
    });

    return await dynamicRateLimiter.execute(async () => {
        return await AsyncUtils.retry(async () => {
            const serverUrl = settings.use_alt_endpoint ? settings.alt_endpoint_url : 'http://localhost:8008';
            const cleanUrl = serverUrl.replace(/\/$/, '');

            const headers = {
                'Content-Type': 'application/json',
            };

            // Use extension settings for API key (custom keys aren't returned by ST's readSecretState)
            if (settings.bananabread_api_key) {
                headers['Authorization'] = `Bearer ${settings.bananabread_api_key}`;
            }

            const fetchPromise = fetch(`${cleanUrl}/v1/embeddings`, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({
                    input: cleanedItems,
                    model: settings.bananabread_model || 'bananabread',
                }),
            });

            const response = await AsyncUtils.timeout(fetchPromise, API_TIMEOUT_MS * 20, 'BananaBread embedding request timed out');

            if (!response.ok) {
                throw new Error(`Failed to get BananaBread embeddings: ${response.status} ${response.statusText}`);
            }

            const data = await response.json();

            // OpenAI format: { data: [{ embedding: [], index: 0, ... }, ...], model: "..." }
            if (!data.data || !Array.isArray(data.data) || data.data.length !== cleanedItems.length) {
                throw new Error(`Invalid response from BananaBread embeddings (OpenAI format): expected ${cleanedItems.length} embeddings, got ${data.data?.length || 0}`);
            }

            // Sort by index to ensure order matches input items
            data.data.sort((a, b) => a.index - b.index);

            // Build map of embeddings keyed by original item text
            const embeddings = /** @type {Record<string, number[]>} */ ({});
            for (let i = 0; i < data.data.length; i++) {
                const embedding = data.data[i].embedding;
                if (!Array.isArray(embedding) || embedding.length === 0) {
                    throw new Error(`BananaBread returned an empty or invalid embedding at index ${i}.`);
                }
                // Map back to original items for hash consistency/lookup
                embeddings[items[i]] = embedding;
            }

            return {
                embeddings: embeddings,
                model: data.model || 'bananabread',
            };
        }, {
            ...RETRY_CONFIG,
            onRetry: (attempt, error) => {
                console.warn(`VectHare: BananaBread embedding retry ${attempt} - ${error.message}`);
            }
        });
    }, settings);
}

/**
 * Throws an error if the source is invalid (missing API key or URL, or missing module)
 * @param {object} settings VectHare settings object
 */
export function throwIfSourceInvalid(settings) {
    const source = settings.source;
    const config = getProviderConfig(source);

    if (!config) {
        throw new Error(`VectHare: Unknown provider ${source}`, { cause: 'unknown_provider' });
    }

    // Check API key requirement
    if (requiresApiKey(source)) {
        const secretKey = getSecretKey(source);
        if (secretKey && !secret_state[secretKey]) {
            // Special case: VertexAI can use service account as fallback
            if (source === 'vertexai' && secret_state['VERTEXAI_SERVICE_ACCOUNT']) {
                // Service account auth is available, continue
            } else {
                throw new Error('VectHare: API key missing', { cause: 'api_key_missing' });
            }
        }
    }

    // Check URL requirement
    if (requiresUrl(source)) {
        if (settings.use_alt_endpoint) {
            if (!settings.alt_endpoint_url) {
                throw new Error('VectHare: API URL missing', { cause: 'api_url_missing' });
            }
        } else {
            // Check textgen settings for local providers
            const textgenMapping = {
                'ollama': textgen_types.OLLAMA,
                'vllm': textgen_types.VLLM,
                'koboldcpp': textgen_types.KOBOLDCPP,
                'llamacpp': textgen_types.LLAMACPP
            };

            if (textgenMapping[source] && !textgenerationwebui_settings.server_urls[textgenMapping[source]]) {
                throw new Error('VectHare: API URL missing', { cause: 'api_url_missing' });
            }
        }
    }

    // Check model requirement
    if (config.requiresModel) {
        const modelField = getModelField(source);
        if (modelField && !settings[modelField]) {
            throw new Error('VectHare: API model missing', { cause: 'api_model_missing' });
        }
    }

    // Special case: extras requires embeddings module
    if (source === 'extras' && !modules.includes('embeddings')) {
        throw new Error('VectHare: Embeddings module missing', { cause: 'extras_module_missing' });
    }

    // Special case: WebLLM requires browser support
    if (source === 'webllm' && !isWebLlmSupported()) {
        throw new Error('VectHare: WebLLM is not supported', { cause: 'webllm_not_supported' });
    }
}

/**
 * Gets the saved hashes for a collection
 * @param {string} collectionId Collection ID
 * @param {object} settings VectHare settings object
 * @param {boolean} includeMetadata If true, returns {hashes: [], metadata: []} instead of just hashes
 * @returns {Promise<number[]|{hashes: number[], metadata: object[]}>} Saved hashes or full data
 */
async function getSavedHashesResolved(collectionId, settings, includeMetadata = false) {
    const routed = storageSettings(settings);
    const hashes = await getStorageHashes(collectionId, routed);

    if (!includeMetadata) {
        return hashes;
    }

    // Use unified chunks API to get full metadata (works with all backends)
    try {
        const backendName = routed.vector_backend || 'standard';
        const response = await pluginRequest('/chunks/list', { body: {
                backend: backendName === 'standard' ? 'vectra' : backendName,
                collectionId: collectionId,
                source: routed.source || 'transformers',
                model: routed.model || '',
                limit: 10000
            } });

        if (response.ok) {
            const data = await response.json();
            if (data.success && data.items) {
                return {
                    hashes: hashes,
                    metadata: data.items.map(item => item.metadata || item)
                };
            }
        }
    } catch (error) {
        console.warn('VectHare: Failed to get full metadata from chunks API, returning hashes only', error);
    }

    // Fallback: return hashes as array (old format)
    return hashes;
}

/**
 * Inserts vector items into a collection
 * Handles batching and rate limiting.
 * For client-side embedding sources (webllm, koboldcpp, bananabread), generates embeddings first.
 * @param {string} collectionId - The collection to insert into
 * @param {{ hash: number, text: string }[]} items - The items to insert
 * @param {object} settings VectHare settings object
 * @param {Function} onProgress - Optional callback (embedded, total) => void for progress updates
 * @returns {Promise<void>}
 */
async function insertVectorItemsResolved(collectionId, items, settings, onProgress = null) {
    assertWritableEmbedding(settings);
    const routed = routedSettings(settings);
    const backend = await getBackend(routed);

    // Sources that require client-side embedding generation

    try {
        // If source requires client-side embeddings, use streaming approach
        if (usesClientEmbeddings(settings)) {
            logger.debug(`VectHare: Streaming embeddings and writing for ${settings.source}...`);

            // Extract text strings - getAdditionalArgs expects string[], not objects
            const textStrings = items.map(item => {
                const text = item.text || item;
                // Ensure we have valid text (not empty after cleaning)
                return typeof text === 'string' && text.trim().length > 0 ? text : ' ';
            });

            // Use streaming embedding generation with immediate writes
            await streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress, routed);
        } else {
            requirePrecomputedForReassignment(settings, routed);
            // Server-side embeddings - backend handles everything
            // VEC-6: Use configurable batch size for optimized bulk inserts
            // Some providers need smaller batches - Ollama and Transformers work best with batch size of 1
            const smallBatchProviders = ['transformers', 'ollama'];
            const configuredBatchSize = settings.insert_batch_size || 50;
            const BATCH_SIZE = smallBatchProviders.includes(settings.source) ? 1 : configuredBatchSize;
            const batches = chunkArray(items, BATCH_SIZE);

            const hasRateLimit = settings.rate_limit_calls > 0;
            logger.debug(`VectHare: Processing ${items.length} items in ${batches.length} batch(es) of up to ${BATCH_SIZE}${hasRateLimit ? ` with rate limit (Max ${settings.rate_limit_calls} calls / ${settings.rate_limit_interval}s)` : ''}`);

            for (let i = 0; i < batches.length; i++) {
                const processBatch = async () => {
                    await AsyncUtils.retry(async () => {
                        await backend.insertVectorItems(collectionId, batches[i], routed);
                    }, RETRY_CONFIG);
                };

                // Apply rate limiting if configured, otherwise execute directly
                if (hasRateLimit) {
                    await dynamicRateLimiter.execute(processBatch, settings);
                } else {
                    await processBatch();
                }

                if (onProgress) {
                    const embeddedCount = (i + 1) * BATCH_SIZE;
                    const actualEmbedded = Math.min(embeddedCount, items.length);
                    onProgress(actualEmbedded, items.length);
                }
            }
        }

        // VEC-18: Record successful insert operation
        recordInsert(settings?.vector_backend || 'standard', items.length);
        indexLexicalItems(collectionStorageKey(collectionId, settings), items);
    } catch (error) {
        // VEC-18: Record error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }
}

/**
 * Stream embeddings and write to database as batches complete
 * @param {object} backend - The backend instance
 * @param {string} collectionId - Collection ID
 * @param {Array} items - Original items
 * @param {string[]} textStrings - Text strings extracted from items
 * @param {object} settings - Settings object
 * @param {Function} onProgress - Progress callback
 */
async function streamEmbeddingsAndWrite(backend, collectionId, items, textStrings, settings, onProgress, routed = settings) {
    // VEC-6: Use configurable batch size for optimized bulk inserts
    const EMBEDDING_BATCH_SIZE = settings.insert_batch_size || 50;
    let totalProcessed = 0;
    const totalBatches = Math.ceil(textStrings.length / EMBEDDING_BATCH_SIZE);

    logger.debug(`VectHare: Streaming ${items.length} items in ${totalBatches} batch(es) of up to ${EMBEDDING_BATCH_SIZE}`);

    // Process embeddings in batches
    for (let i = 0; i < textStrings.length; i += EMBEDDING_BATCH_SIZE) {
        const batchEnd = Math.min(i + EMBEDDING_BATCH_SIZE, textStrings.length);
        const batchTextStrings = textStrings.slice(i, batchEnd);
        const batchItems = items.slice(i, batchEnd);
        const batchNum = Math.floor(i / EMBEDDING_BATCH_SIZE) + 1;

        logger.debug(`VectHare: Embedding batch ${batchNum}/${totalBatches} (items ${i + 1}-${batchEnd})`);

        // VEC-6: Retry logic per batch instead of per chunk
        let additionalArgs;
        try {
            additionalArgs = await AsyncUtils.retry(async () => {
                return await getAdditionalArgs(batchTextStrings, settings);
            }, RETRY_CONFIG);
        } catch (error) {
            throw new Error(`VectHare: Failed to generate embeddings for batch ${batchNum} after retries: ${error.message}`);
        }

        if (!additionalArgs.embeddings) {
            throw new Error(`VectHare: No embeddings returned from ${settings.source} for batch ${batchNum}`);
        }

        // Attach embeddings to items and validate
        let missingEmbeddings = 0;
        const itemsToWrite = [];

        for (let j = 0; j < batchItems.length; j++) {
            const text = batchTextStrings[j];
            const embedding = additionalArgs.embeddings[text];

            if (embedding && Array.isArray(embedding) && embedding.length > 0) {
                // Validate embedding values
                const isValidEmbedding = embedding.every(Number.isFinite) && embedding.some(val => val !== 0) && (!settings.embedding_fingerprint?.dimension || embedding.length === settings.embedding_fingerprint.dimension);
                if (!isValidEmbedding) {
                    console.error(`VectHare: Invalid embedding values for item ${i + j}:`, embedding.slice(0, 5));
                    missingEmbeddings++;
                    continue;
                }
                batchItems[j].vector = embedding;
                itemsToWrite.push(batchItems[j]);
            } else {
                missingEmbeddings++;
                console.warn(`VectHare: No embedding found for item ${i + j}, text: "${text.substring(0, 50)}..."`);
            }
        }

        if (missingEmbeddings > 0) {
            throw new Error(`VectHare: Failed to generate embeddings for ${settings.source} - ${missingEmbeddings} items missing in batch`);
        }

        // VEC-6: Write batch to database with retry logic
        logger.debug(`VectHare: Writing batch ${batchNum} to database (${itemsToWrite.length} items)`);
        try {
            await AsyncUtils.retry(async () => {
                requirePrecomputedForReassignment(settings, routed, itemsToWrite[0]?.vector, backend);
                await backend.insertVectorItems(collectionId, itemsToWrite, routed);
            }, RETRY_CONFIG);
        } catch (error) {
            throw new Error(`VectHare: Failed to write batch ${batchNum} to database after retries: ${error.message}`);
        }

        totalProcessed += itemsToWrite.length;

        // Update progress
        if (onProgress) {
            logger.debug(`[Core Vector API] Streamed ${totalProcessed}/${items.length} (${Math.round((totalProcessed / items.length) * 100)}%)`);
            onProgress(totalProcessed, items.length);
        }
    }

    logger.debug(`VectHare: Completed streaming ${totalProcessed} items to database`);
}

/**
 * Deletes vector items from a collection
 * @param {string} collectionId - The collection to delete from
 * @param {number[]} hashes - The hashes of the items to delete
 * @param {object} settings VectHare settings object
 * @returns {Promise<void>}
 */
async function deleteVectorItemsResolved(collectionId, hashes, settings) {
    const routed = storageSettings(settings);
    const backend = await getBackend(routed);
    try {
        // VEC-33: Wrap with health invalidation
        const result = await withHealthInvalidation(
            () => backend.deleteVectorItems(collectionId, hashes, routed),
            settings
        );
        // VEC-18: Record successful delete operation
        recordDelete(settings?.vector_backend || 'standard', hashes.length);
        deleteLexicalItems(collectionStorageKey(collectionId, settings), hashes);
        return result;
    } catch (error) {
        // VEC-18: Record error
        recordError(settings?.vector_backend || 'standard', error);
        throw error;
    }
}

/**
 * Queries a single collection for similar vectors
 * Applies keyword boost system: overfetch → boost → trim
 * For client-side embedding sources (webllm, koboldcpp, bananabread), generates query embedding first.
 * @param {string} collectionId - The collection to query
 * @param {string} searchText - The text to query
 * @param {number} topK - The number of results to return
 * @param {object} settings VectHare settings object
 * @returns {Promise<{ hashes: number[], metadata: object[]}>} - Hashes and metadata of the results
 */
async function queryCollectionResolved(collectionId, searchText, topK, settings) {
    if (settings.retrieval_mode === 'lexical_only') {
        await requireCompleteLexical(collectionId, settings);
        return lexicalResult(collectionId, searchText, topK, settings);
    }
    const routed = routedSettings(settings);
    const backend = await getBackend(routed);
    const backendName = settings?.vector_backend || 'standard';
    const queryVector = await embedQueryVector(searchText, settings);
    requirePrecomputedForReassignment(settings, routed, queryVector, backend);

    const queryStart = Date.now();
    try {
        if (settings.hybrid_search_enabled) {
            const result = await hybridSearch(collectionId, searchText, topK, routed, { queryVector });
            recordQuery(backendName, Date.now() - queryStart);
            return result;
        }
        // Overfetch so keyword-boosted chunks can surface. Never shrink an
        // explicit candidate request below topK.
        const overfetchAmount = Math.max(topK, getOverfetchAmount(topK));
        const rawResults = await backend.queryCollection(collectionId, searchText, overfetchAmount, routed, queryVector);
        recordQuery(backendName, Date.now() - queryStart);
        return scoreBackendResults(rawResults, searchText, topK, settings, overfetchAmount);
    } catch (error) {
        recordError(backendName, error);
        throw error;
    }
}

function scoreResults(resultsForBoost, searchText, topK, settings, overfetchAmount = null) {
    let finalResults;

    // VEC-24: Ensure overfetchAmount has a valid fallback to prevent ReferenceError
    const safeOverfetchAmount = overfetchAmount ?? resultsForBoost.length;

    // Determine scoring method from settings
    const scoringMethod = settings.keyword_scoring_method || 'keyword'; // 'keyword', 'bm25', or 'hybrid'
    if (scoringMethod === 'bm25') {
        // Use BM25 scoring only
        const bm25Results = applyBM25Scoring(resultsForBoost, searchText, {
            k1: settings.bm25_k1 || 1.5,
            b: settings.bm25_b || 0.75,
            alpha: 0.5,
            beta: 0.5
        });
        finalResults = bm25Results.slice(0, topK);
    } else if (scoringMethod === 'hybrid') {
        // Use both keyword boost and BM25
        // VEC-24: Use safe overfetch amount
        const keywordBoostLimit = safeOverfetchAmount;
        const keywordBoosted = applyKeywordBoosts(resultsForBoost, searchText, keywordBoostLimit);
        const hybridResults = applyBM25Scoring(keywordBoosted, searchText, {
            k1: settings.bm25_k1 || 1.5,
            b: settings.bm25_b || 0.75,
            alpha: 0.6,
            beta: 0.4
        });
        finalResults = hybridResults.slice(0, topK);
    } else {
        // Use traditional keyword boost (default)
        finalResults = applyKeywordBoosts(resultsForBoost, searchText, topK);
    }
    return finalResults;
}

/**
 * Queries multiple collections for a given text.
 * For client-side embedding sources, generates query embedding once and reuses for all collections.
 * @param {string[]} collectionIds - Collection IDs to query
 * @param {string} searchText - Text to query
 * @param {number} topK - Number of results to return
 * @param {number} threshold - Score threshold
 * @param {object} settings VectHare settings object
 * @returns {Promise<Record<string, { hashes: number[], metadata: object[] }>>} - Results mapped to collection IDs
 */
async function queryMultipleCollectionsResolved(collectionIds, searchText, topK, threshold, settings) {
    if (settings.retrieval_mode === 'lexical_only') {
        await Promise.all(collectionIds.map(id => requireCompleteLexical(id, settings)));
        return Object.fromEntries(collectionIds.map(id => [id, lexicalResult(id, searchText, topK, settings)]));
    }
    const totalStart = performance.now();
    const routed = routedSettings(settings);
    const backend = await getBackend(routed);
    const backendName = settings?.vector_backend || 'standard';

    // Embed the query once for all collections.
    const embeddingStart = performance.now();
    const queryVector = await embedQueryVector(searchText, settings);
    const queryEmbeddingMs = performance.now() - embeddingStart;
    requirePrecomputedForReassignment(settings, routed, queryVector, backend);

    const withTimings = (results, backendSearchMs) => Object.defineProperty(results, '_timings', {
        value: { queryEmbeddingMs, backendSearchMs, totalRetrievalMs: performance.now() - totalStart },
        enumerable: false,
    });

    const backendStart = performance.now();
    if (settings.hybrid_search_enabled) {
        const processedResults = {};
        const concurrency = Math.max(1, Math.min(8, Number(settings.multi_query_concurrency) || 4));
        await AsyncUtils.parallel(collectionIds.map(collectionId => async () => {
            const queryStart = Date.now();
            try {
                processedResults[collectionId] = await hybridSearch(collectionId, searchText, topK, routed, { queryVector });
                recordQuery(backendName, Date.now() - queryStart);
            } catch (error) {
                console.warn(`[VectHare] Hybrid search failed for ${collectionId}:`, error.message);
                recordError(backendName, error);
                processedResults[collectionId] = { hashes: [], metadata: [], error: error.message };
            }
        }), concurrency);
        return withTimings(processedResults, performance.now() - backendStart);
    }

    // Do not let the generic overfetch cap shrink the candidate window.
    const overfetchAmount = Math.max(topK, getOverfetchAmount(topK));
    const queryStart = Date.now();
    let rawResults;
    try {
        rawResults = await backend.queryMultipleCollections(collectionIds, searchText, overfetchAmount, threshold, routed, queryVector);
        recordQuery(backendName, Date.now() - queryStart);
    } catch (error) {
        recordError(backendName, error);
        throw error;
    }
    const backendSearchMs = performance.now() - backendStart;

    const processedResults = {};
    for (const [collectionId, collectionResults] of Object.entries(rawResults)) {
        processedResults[collectionId] = collectionResults?.metadata
            ? scoreBackendResults(collectionResults, searchText, topK, settings, overfetchAmount)
            : collectionResults;
    }
    return withTimings(processedResults, backendSearchMs);
}

/**
 * Purges the vector index for a collection.
 * @param {string} collectionId Collection ID to purge
 * @param {object} settings VectHare settings object
 * @returns {Promise<boolean>} True if deleted, false if not
 */
async function purgeVectorIndexResolved(collectionId, settings) {
    try {
        const routed = storageSettings(settings);
        const backend = await getBackend(routed);
        await backend.purgeVectorIndex(collectionId, routed);
        purgeLexicalIndex(collectionStorageKey(collectionId, settings));
        logger.debug(`VectHare: Purged vector index for collection ${collectionId}`);
        return true;
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        console.error('VectHare: Failed to purge', error);
        return false;
    }
}

/**
 * Purges the vector index for a file.
 * @param {string} collectionId File collection ID to purge
 * @param {object} settings VectHare settings object
 * @returns {Promise<void>}
 */
async function purgeFileVectorIndexResolved(collectionId, settings) {
    try {
        logger.debug(`VectHare: Purging file vector index for collection ${collectionId}`);
        const routed = storageSettings(settings);
        const backend = await getBackend(routed);
        await backend.purgeFileVectorIndex(collectionId, routed);
        purgeLexicalIndex(collectionStorageKey(collectionId, settings));
        logger.debug(`VectHare: Purged vector index for collection ${collectionId}`);
    } catch (error) {
        // VEC-33: Invalidate health cache on operation error
        invalidateBackendHealth(settings?.vector_backend || 'standard', error);
        console.error('VectHare: Failed to purge file', error);
    }
}

/**
 * Update chunk text (triggers re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {string} newText - New text content
 * @param {object} settings - VectHare settings
 */
async function updateChunkTextResolved(collectionId, hash, newText, settings) {
    assertWritableEmbedding(settings);
    const routed = storageSettings(settings);
    const backend = await getBackend(routed);
    let result;
    if (usesClientEmbeddings(settings)) {
        throw new Error('Safe text editing with client-generated vectors requires an upstream atomic chunk vector update. Rebuild into a new collection to change text; no chunk was modified.');
    } else {
        requirePrecomputedForReassignment(settings, routed);
        result = await backend.updateChunkText(collectionId, hash, newText, routed);
    }
    indexLexicalItems(collectionStorageKey(collectionId, settings), [{ hash, text: newText }]);
    return result;
}

/**
 * Update chunk metadata (no re-embedding)
 * @param {string} collectionId - Collection ID
 * @param {number} hash - Chunk hash
 * @param {object} metadata - Metadata to update (keywords, enabled, etc.)
 * @param {object} settings - VectHare settings
 */
async function updateChunkMetadataResolved(collectionId, hash, metadata, settings) {
    const routed = storageSettings(settings);
    const backend = await getBackend(routed);
    return await backend.updateChunkMetadata(collectionId, hash, metadata, routed);
}

export async function getSavedHashes(collectionId, settings, includeMetadata = false) {
    const resolved = resolveCollectionSettings(collectionId, settings);
    const id = physicalCollectionId(collectionId, resolved);
    return await getSavedHashesResolved(id, resolved, includeMetadata);
}

export async function insertVectorItems(collectionId, items, settings, onProgress = null) {
    const resolved = resolveCollectionSettings(collectionId, settings);
    const id = physicalCollectionId(collectionId, resolved);
    return await collectionMutation(id, resolved, () => insertVectorItemsResolved(id, items, resolved, onProgress));
}

export async function deleteVectorItems(collectionId, hashes, settings) {
    const resolved = resolveCollectionSettings(collectionId, settings);
    const id = physicalCollectionId(collectionId, resolved);
    return await collectionMutation(id, resolved, () => deleteVectorItemsResolved(id, hashes, resolved));
}

export async function purgeVectorIndex(collectionId, settings) {
    const resolved = resolveCollectionSettings(collectionId, settings);
    const id = physicalCollectionId(collectionId, resolved);
    return await collectionMutation(id, resolved, () => purgeVectorIndexResolved(id, resolved));
}

export async function purgeFileVectorIndex(collectionId, settings) {
    const resolved = resolveCollectionSettings(collectionId, settings);
    const id = physicalCollectionId(collectionId, resolved);
    return await collectionMutation(id, resolved, () => purgeFileVectorIndexResolved(id, resolved));
}

export async function updateChunkText(collectionId, hash, newText, settings) {
    const resolved = resolveCollectionSettings(collectionId, settings);
    const id = physicalCollectionId(collectionId, resolved);
    return await collectionMutation(id, resolved, () => updateChunkTextResolved(id, hash, newText, resolved));
}

export async function updateChunkMetadata(collectionId, hash, metadata, settings) {
    const resolved = resolveCollectionSettings(collectionId, settings);
    const id = physicalCollectionId(collectionId, resolved);
    return await collectionMutation(id, resolved, () => updateChunkMetadataResolved(id, hash, metadata, resolved));
}

export async function queryCollection(collectionId, searchText, topK, settings) {
    const resolved = resolveCollectionSettings(collectionId, settings);
    const id = physicalCollectionId(collectionId, resolved);
    return await queryCollectionResolved(id, searchText, topK, resolved);
}

async function requireCompleteLexical(id, settings) {
    const routed = storageSettings(settings);
    const hashes = await getStorageHashes(id, routed);
    if (!completeLexicalCoverage(collectionStorageKey(id, settings), hashes)) {
        throw new Error('Lexical-only retrieval unavailable: incomplete text coverage. Rebuild the lexical index from all stored chunks.');
    }
}

export async function queryMultipleCollections(collectionIds, searchText, topK, threshold, settings) {
    const groups = new Map();
    for (const logicalId of collectionIds) {
        const resolved = resolveCollectionSettings(logicalId, settings);
        const key = embeddingProfileKey(resolved);
        if (!groups.has(key)) groups.set(key, { settings: resolved, entries: [] });
        groups.get(key).entries.push({ logicalId, id: physicalCollectionId(logicalId, resolved) });
    }
    const results = {};
    const timings = { queryEmbeddingMs: 0, backendSearchMs: 0, totalRetrievalMs: 0 };
    for (const group of groups.values()) {
        const raw = await queryMultipleCollectionsResolved([...new Set(group.entries.map(e => e.id))], searchText, topK, threshold, { ...group.settings, collection_locator: group.settings.collection_locator ? { ...group.settings.collection_locator, collectionId: undefined } : null });
        for (const entry of group.entries) results[entry.logicalId] = raw[entry.id] || { hashes: [], metadata: [] };
        for (const field of Object.keys(timings)) timings[field] += raw._timings?.[field] || 0;
    }
    Object.defineProperty(results, '_timings', { value: timings, enumerable: false });
    return results;
}
