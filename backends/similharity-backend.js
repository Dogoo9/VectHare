/**
 * ============================================================================
 * SIMILHARITY PLUGIN BACKEND BASE
 * ============================================================================
 * Shared implementation for backends that talk to the Similharity server
 * plugin's unified /chunks/* API (LanceDB, Milvus, Qdrant). Subclasses only
 * describe what differs: initialization, how a collection is addressed
 * (`_target`), and optional insert/hybrid tweaks.
 * ============================================================================
 */

import { getRequestHeaders } from '../../../../../script.js';
import { VectorBackend } from './backend-interface.js';
import { getModelField } from '../core/providers.js';
import { VECTOR_LIST_LIMIT } from '../core/constants.js';
import { stripRegistryPrefix } from '../core/collection-ids.js';
import AsyncUtils from '../utils/async-utils.js';
import { logger } from '../utils/logger.js';

export const PLUGIN_API = '/api/plugins/similharity';

/**
 * Sends a request to the Similharity plugin.
 * @param {string} path Path below /api/plugins/similharity
 * @param {object} [options]
 * @param {string} [options.method] HTTP method (POST when a body is given, else GET)
 * @param {object} [options.body] JSON body
 * @param {object} [options.query] Query-string parameters
 * @returns {Promise<Response>}
 */
export function pluginRequest(path, { method, body, query } = {}) {
    const url = `${PLUGIN_API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
    return fetch(url, {
        method: method || (body !== undefined ? 'POST' : 'GET'),
        headers: getRequestHeaders(),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
}

/**
 * Model name for the storage namespace: the collection locator wins, then the
 * provider's model setting.
 * @param {object} settings
 * @returns {string}
 */
export function modelFromSettings(settings) {
    const locator = settings.collection_locator || settings.storageLocator;
    if (locator) return locator.model ?? '';
    const modelField = getModelField(settings.source);
    return modelField ? settings[modelField] || '' : '';
}

/** Converts plugin result rows to { hashes, metadata }. */
export function formatResults(rows = []) {
    return {
        hashes: rows.map(r => r.hash),
        metadata: rows.map(r => ({ hash: r.hash, text: r.text, score: r.score, ...r.metadata })),
    };
}

/** Item fields VectHare stores in metadata, accepted at top level or in metadata. */
const PASSTHROUGH_FIELDS = [
    'importance', 'keywords', 'customWeights', 'disabledKeywords', 'chunkGroup',
    'conditions', 'summary', 'isSummaryChunk', 'parentHash',
];

export class SimilharityBackend extends VectorBackend {
    /**
     * @param {string} type Backend name sent to the plugin
     * @param {string} label Name used in log and error messages
     */
    constructor(type, label) {
        super();
        this.type = type;
        this.label = label;
        /** Items per insert request; Infinity sends everything at once. */
        this.insertBatchSize = Infinity;
        /** Skip the request when there is neither a query vector nor text. */
        this.requireQueryInput = false;
    }

    // ------------------------------------------------------------------------
    // Hooks for subclasses
    // ------------------------------------------------------------------------

    _stripRegistryPrefix(collectionId) {
        return stripRegistryPrefix(collectionId);
    }

    /**
     * Request fields that address a collection for an operation.
     * @param {string} collectionId Logical collection ID (may be a registry key)
     * @param {object} settings
     * @param {string} _op list|insert|delete|query|hybrid|purge|chunk|listChunks|updateText|updateMetadata|stats
     * @returns {object}
     */
    _target(collectionId, settings, _op) {
        return { collectionId: this._stripRegistryPrefix(collectionId) };
    }

    /** Converts an item to the shape the insert endpoint expects. */
    _mapItem(item, _settings, _collectionId) {
        const metadata = { ...item.metadata };
        for (const field of PASSTHROUGH_FIELDS) {
            metadata[field] = item[field] ?? item.metadata?.[field];
        }
        return { hash: item.hash, text: item.text, index: item.index, vector: item.vector, metadata };
    }

    /** Builds the error thrown for a failed insert. */
    _insertError(collectionId, count, status, errorBody) {
        return new Error(`[${this.label}] Failed to insert ${count} vectors into ${collectionId}: ${status} - ${errorBody}`);
    }

    /** Called after every batch of an insert succeeded. */
    async _afterInsert(_collectionId, _items, _settings) {}

    // ------------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------------

    /** Common request body: backend, optional inference args, target, extras, source and model. */
    _body(collectionId, settings, op, extra = {}, { inference = false } = {}) {
        return {
            backend: this.type,
            ...(inference ? settings.inference_request_args : {}),
            ...this._target(collectionId, settings, op),
            ...extra,
            source: settings.source || 'transformers',
            model: modelFromSettings(settings),
        };
    }

    /** Throws a descriptive error for a non-OK response. */
    async _throwIfFailed(response, what) {
        if (response.ok) return;
        const errorBody = await response.text().catch(() => 'No response body');
        throw new Error(`[${this.label}] Failed to ${what}: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    async _post(path, body, what) {
        const response = await pluginRequest(path, { body });
        await this._throwIfFailed(response, what);
        return response.json();
    }

    // ------------------------------------------------------------------------
    // VectorBackend implementation
    // ------------------------------------------------------------------------

    async healthCheck() {
        try {
            const response = await pluginRequest(`/backend/health/${this.type}`);
            if (!response.ok) return false;
            const data = await response.json();
            return data.healthy === true;
        } catch (error) {
            console.error(`[${this.label}] Health check failed:`, error);
            return false;
        }
    }

    async getSavedHashes(collectionId, settings) {
        const data = await this._post('/chunks/list',
            this._body(collectionId, settings, 'list', { limit: VECTOR_LIST_LIMIT }),
            `get saved hashes for ${collectionId}`);
        return data.items ? data.items.map(item => item.hash) : [];
    }

    async insertVectorItems(collectionId, items, settings) {
        if (items.length === 0) return;
        const batchSize = Math.min(this.insertBatchSize, items.length);

        for (let start = 0; start < items.length; start += batchSize) {
            const batch = items.slice(start, start + batchSize);
            const response = await pluginRequest('/chunks/insert', {
                body: this._body(collectionId, settings, 'insert', {
                    items: batch.map(item => this._mapItem(item, settings, collectionId)),
                }, { inference: true }),
            });
            if (!response.ok) {
                const errorBody = await response.text().catch(() => 'No response body');
                throw this._insertError(collectionId, items.length, `${response.status} ${response.statusText}`, errorBody);
            }
        }

        await this._afterInsert(collectionId, items, settings);
        logger.debug(`VectHare ${this.label}: Inserted ${items.length} vectors into ${collectionId}`);
    }

    async deleteVectorItems(collectionId, hashes, settings) {
        const response = await pluginRequest('/chunks/delete', {
            body: this._body(collectionId, settings, 'delete', { hashes }),
        });
        await this._throwIfFailed(response, `delete vectors from ${collectionId}`);
    }

    /** One query request; returns null when skipped for lack of input. */
    async _query(collectionId, searchText, topK, threshold, settings, queryVector) {
        if (this.requireQueryInput && !queryVector && !searchText?.trim()) {
            console.warn(`[${this.label}] No queryVector or searchText for ${collectionId}`);
            return null;
        }
        const response = await pluginRequest('/chunks/query', {
            body: this._body(collectionId, settings, 'query', {
                searchText,
                topK,
                threshold,
                ...(queryVector ? { queryVector } : {}),
            }, { inference: true }),
        });
        await this._throwIfFailed(response, `query collection ${collectionId}`);
        const data = await response.json();
        return formatResults(data.results || data.chunks || []);
    }

    async queryCollection(collectionId, searchText, topK, settings, queryVector = null) {
        return await this._query(collectionId, searchText, topK, 0.0, settings, queryVector)
            ?? { hashes: [], metadata: [] };
    }

    async queryMultipleCollections(collectionIds, searchText, topK, threshold, settings, queryVector = null) {
        const results = {};
        const concurrency = Math.max(1, Math.min(8, Number(settings.multi_query_concurrency) || 4));
        await AsyncUtils.parallel(collectionIds.map(collectionId => async () => {
            try {
                results[collectionId] = await this._query(collectionId, searchText, topK, threshold, settings, queryVector)
                    ?? { hashes: [], metadata: [] };
            } catch (error) {
                console.error(`VectHare: Query failed for ${collectionId}:`, error.message);
                results[collectionId] = { hashes: [], metadata: [], error: error.message };
            }
        }), concurrency);
        return results;
    }

    async purgeVectorIndex(collectionId, settings) {
        const response = await pluginRequest('/chunks/purge', {
            body: this._body(collectionId, settings, 'purge'),
        });
        await this._throwIfFailed(response, `purge collection ${collectionId}`);
    }

    async purgeFileVectorIndex(collectionId, settings) {
        return this.purgeVectorIndex(collectionId, settings);
    }

    async getChunk(collectionId, hash, settings) {
        const { backend, collectionId: targetId, source, model } = this._body(collectionId, settings, 'chunk');
        const response = await pluginRequest(`/chunks/${encodeURIComponent(hash)}`, {
            query: { backend, collectionId: targetId, source, model },
        });
        if (response.status === 404) return null;
        await this._throwIfFailed(response, `get chunk ${hash} from ${collectionId}`);
        const data = await response.json();
        return data.chunk;
    }

    async listChunks(collectionId, settings, options = {}) {
        return this._post('/chunks/list', this._body(collectionId, settings, 'listChunks', {
            offset: options.offset || 0,
            limit: options.limit || 100,
            includeVectors: options.includeVectors || false,
        }), `list chunks in ${collectionId}`);
    }

    async updateChunkText(collectionId, hash, newText, settings) {
        const response = await pluginRequest(`/chunks/${encodeURIComponent(hash)}/text`, {
            method: 'PATCH',
            body: this._body(collectionId, settings, 'updateText', { text: newText }, { inference: true }),
        });
        await this._throwIfFailed(response, `update chunk text in ${collectionId} (hash: ${hash})`);
        return response.json();
    }

    async updateChunkMetadata(collectionId, hash, metadata, settings) {
        const response = await pluginRequest(`/chunks/${encodeURIComponent(hash)}/metadata`, {
            method: 'PATCH',
            body: this._body(collectionId, settings, 'updateMetadata', { metadata }),
        });
        await this._throwIfFailed(response, `update chunk metadata in ${collectionId} (hash: ${hash})`);
        return response.json();
    }

    async getStats(collectionId, settings) {
        const data = await this._post('/chunks/stats', this._body(collectionId, settings, 'stats'),
            `get stats for ${collectionId}`);
        return data.stats;
    }

    /**
     * Native hybrid search through the plugin's /chunks/hybrid-query endpoint,
     * falling back to vector-only search if it is unavailable. Only used when
     * a subclass returns true from supportsHybridSearch().
     */
    async hybridQuery(collectionId, searchText, topK, settings, hybridOptions = {}) {
        if (!this.supportsHybridSearch()) return super.hybridQuery(collectionId, searchText, topK, settings, hybridOptions);
        const { vectorWeight = 0.5, textWeight = 0.5, fusionMethod = 'rrf', rrfK = 60 } = hybridOptions;
        try {
            const response = await pluginRequest('/chunks/hybrid-query', {
                body: this._body(collectionId, settings, 'hybrid', {
                    searchText,
                    topK,
                    threshold: 0.0,
                    hybrid: true,
                    hybridOptions: { vectorWeight, textWeight, fusionMethod, rrfK },
                }, { inference: true }),
            });
            if (response.ok) {
                const data = await response.json();
                const rows = data.results || [];
                return {
                    hashes: rows.map(r => r.hash),
                    metadata: rows.map(r => ({
                        hash: r.hash,
                        text: r.text,
                        score: r.score,
                        vectorScore: r.vectorScore || r.debug?.vectorScore,
                        textScore: r.textScore || r.debug?.keywordScore,
                        fusionMethod: r.debug?.fusionMethod || fusionMethod,
                        hybridSearch: true,
                        vectorRank: r.debug?.vectorRank,
                        keywordRank: r.debug?.keywordRank,
                        matchedKeywords: r.debug?.matchedKeywords,
                        ...r.metadata,
                    })),
                };
            }
            console.warn(`[${this.label}] Hybrid endpoint not available (${response.status}), falling back to vector-only search`);
        } catch (error) {
            console.warn(`[${this.label}] Hybrid search failed:`, error.message);
        }
        return this.queryCollection(collectionId, searchText, topK, settings);
    }
}
