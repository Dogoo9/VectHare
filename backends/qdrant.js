/**
 * ============================================================================
 * QDRANT BACKEND (via Similharity plugin)
 * ============================================================================
 * Local Qdrant or Qdrant Cloud.
 *
 * SEPARATE COLLECTIONS MODE (qdrant_multitenancy = false, default):
 *   one Qdrant collection per VectHare collection.
 * MULTITENANCY MODE (qdrant_multitenancy = true):
 *   one shared "vecthare_multitenancy" collection; every point carries a
 *   content_type payload field and list/insert/delete/query requests filter
 *   on it. Purge, single-chunk, stats and update requests still address the
 *   per-collection name, as they always have.
 * ============================================================================
 */

import { SimilharityBackend, pluginRequest } from './similharity-backend.js';
import { logger } from '../utils/logger.js';

const MULTITENANCY_COLLECTION = 'vecthare_multitenancy';
/** Operations that are tenant-filtered in multitenancy mode. */
const TENANT_OPS = new Set(['list', 'insert', 'delete', 'query', 'hybrid']);
/** Qdrant rejects payloads over 32MB; 100 items stays well below that. */
const INSERT_BATCH_SIZE = 100;

export class QdrantBackend extends SimilharityBackend {
    constructor() {
        super('qdrant', 'Qdrant');
        this.insertBatchSize = INSERT_BATCH_SIZE;
        this.requireQueryInput = true;
    }

    supportsHybridSearch() {
        return true;
    }

    async initialize(settings) {
        // Send only the config for the selected mode, clearing the other one.
        const config = settings.qdrant_use_cloud
            ? { url: settings.qdrant_url || null, apiKey: settings.qdrant_api_key || null, host: null, port: null }
            : { host: settings.qdrant_host || 'localhost', port: settings.qdrant_port || 6333, url: null, apiKey: null };
        logger.debug(settings.qdrant_use_cloud
            ? `VectHare: Initializing Qdrant Cloud: ${config.url}`
            : `VectHare: Initializing local Qdrant: ${config.host}:${config.port}`);

        const response = await pluginRequest('/backend/init/qdrant', { body: config });
        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Qdrant] Failed to initialize Qdrant: ${response.status} ${response.statusText} - ${errorBody}`);
        }
        logger.debug('VectHare: Using Qdrant backend (production-grade vector search)');
    }

    _target(collectionId, settings, op) {
        const id = this._stripRegistryPrefix(collectionId);
        if (!settings.qdrant_multitenancy || !TENANT_OPS.has(op)) return { collectionId: id };
        if (op === 'insert') return { collectionId: MULTITENANCY_COLLECTION };
        return {
            collectionId: MULTITENANCY_COLLECTION,
            filter: { must: [{ key: 'content_type', match: { value: id } }] },
        };
    }

    _mapItem(item, settings, collectionId) {
        const mapped = super._mapItem(item, settings, collectionId);
        // Without a precomputed vector the plugin embeds the text, so include
        // keywords in it to make them searchable.
        if (!item.vector && item.keywords?.length > 0) {
            mapped.text = `${item.text || ''} [KEYWORDS: ${item.keywords.map(kw => kw.text || kw).join(' ')}]`;
        } else {
            mapped.text = item.text || '';
        }
        if (settings.qdrant_multitenancy) {
            mapped.metadata.content_type = this._stripRegistryPrefix(collectionId);
        }
        return mapped;
    }

    _insertError(collectionId, count, status, errorBody) {
        if (errorBody.includes('dimension')) {
            const match = errorBody.match(/expected dim: (\d+), got (\d+)/);
            const detail = match
                ? `expects ${match[1]}-dimensional vectors, but received ${match[2]}-dimensional vectors`
                : `has a vector dimension mismatch (${errorBody})`;
            return new Error(`[Qdrant] Collection "${collectionId}" ${detail}. This happens when switching embedding models. ` +
                'Solution: Delete the collection in Database Browser, then re-vectorize.');
        }
        return super._insertError(collectionId, count, status, errorBody);
    }

    async _afterInsert(collectionId, _items, settings) {
        try {
            // Dynamic import avoids a circular dependency. Discovery uses
            // backend:source:id; edits reinsert with a bare ID, and registering
            // that separately would make the collection searchable twice.
            const { registerCollection } = await import('../core/collection-loader.js');
            registerCollection(`${this.type}:${settings.source || 'transformers'}:${this._stripRegistryPrefix(collectionId)}`);
        } catch (error) {
            console.warn('VectHare: Failed to register collection after Qdrant insert:', error);
        }
    }

    async purgeAllVectorIndexes(_settings) {
        throw new Error('purgeAllVectorIndexes requires collection IDs - call purgeVectorIndex for each collection instead');
    }
}
