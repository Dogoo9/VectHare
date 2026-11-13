/**
 * ============================================================================
 * MILVUS BACKEND (via Similharity plugin)
 * ============================================================================
 * External Milvus server. All VectHare data lives in ONE collection
 * ("vecthare_main"); each logical collection is a tenant addressed by
 * { type, sourceId } payload filters.
 * ============================================================================
 */

import { SimilharityBackend, pluginRequest, modelFromSettings } from './similharity-backend.js';
import { stripRegistryPrefix } from '../core/collection-ids.js';

const MAIN_COLLECTION = 'vecthare_main';
/** Operations whose plugin endpoint does not take tenant filters. */
const UNFILTERED_OPS = new Set(['chunk']);

export class MilvusBackend extends SimilharityBackend {
    constructor() {
        super('milvus', 'Milvus');
    }

    supportsHybridSearch() {
        return true;
    }

    /** Asks the plugin for a test embedding to learn the vector dimension. */
    async _autoDetectDimensions(settings) {
        try {
            const response = await pluginRequest('/get-embedding', {
                body: { text: 'test', source: settings.source || 'transformers', model: modelFromSettings(settings) },
            });
            if (response.ok) {
                const data = await response.json();
                if (data.success && Array.isArray(data.embedding)) return data.embedding.length;
            }
        } catch (error) {
            console.warn('VectHare: Failed to auto-detect dimensions:', error);
        }
        return null;
    }

    async initialize(settings) {
        // Manual setting > auto-detect > plugin default
        let dimensions = settings.milvus_dimensions ? parseInt(settings.milvus_dimensions) : null;
        if (!dimensions || isNaN(dimensions)) {
            dimensions = await this._autoDetectDimensions(settings);
        }

        const config = {
            host: settings.milvus_host || 'localhost',
            port: settings.milvus_port || 19530,
            address: settings.milvus_address || (settings.milvus_host ? `${settings.milvus_host}:${settings.milvus_port || 19530}` : 'localhost:19530'),
            username: settings.milvus_username || null,
            password: settings.milvus_password || null,
            token: settings.milvus_token || null,
            dimensions,
        };

        const response = await pluginRequest('/backend/init/milvus', { body: config });
        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`[Milvus] Failed to initialize Milvus: ${response.status} ${response.statusText} - ${errorBody}`);
        }
        console.log('VectHare: Using Milvus backend (production-grade vector search)');
    }

    /**
     * Parses a collection ID into its tenant { type, sourceId }.
     * New format: vh:{type}:{sourceId}; legacy: vecthare_{type}_{sourceId}.
     */
    _parseCollectionId(collectionId) {
        if (!collectionId || typeof collectionId !== 'string') {
            return { type: 'unknown', sourceId: 'unknown' };
        }
        const id = stripRegistryPrefix(collectionId);

        const idParts = id.split(':');
        if (idParts.length >= 3 && idParts[0] === 'vh') {
            return { type: idParts[1], sourceId: idParts.slice(2).join(':') };
        }

        const legacyParts = id.split('_');
        if (legacyParts.length >= 3 && legacyParts[0] === 'vecthare') {
            return { type: legacyParts[1], sourceId: legacyParts.slice(2).join('_') };
        }

        console.warn('VectHare: Unknown collection ID format:', id);
        return { type: 'chat', sourceId: id };
    }

    _target(collectionId, _settings, op) {
        if (UNFILTERED_OPS.has(op)) return { collectionId: MAIN_COLLECTION };
        const { type, sourceId } = this._parseCollectionId(collectionId);
        return { collectionId: MAIN_COLLECTION, filters: { type, sourceId } };
    }

    async purgeAllVectorIndexes(settings) {
        const response = await pluginRequest('/chunks/purge', {
            body: {
                backend: this.type,
                collectionId: MAIN_COLLECTION,
                source: settings.source || 'transformers',
                model: modelFromSettings(settings),
            },
        });
        await this._throwIfFailed(response, 'purge all collections');
    }
}
