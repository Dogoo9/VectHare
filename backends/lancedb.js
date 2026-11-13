/**
 * ============================================================================
 * LANCEDB BACKEND (via Similharity plugin)
 * ============================================================================
 * Disk-based, scalable columnar vector storage. One LanceDB table per
 * collection. Requires the Similharity server plugin.
 * ============================================================================
 */

import { SimilharityBackend, pluginRequest } from './similharity-backend.js';
import { logger } from '../utils/logger.js';

export class LanceDBBackend extends SimilharityBackend {
    constructor() {
        super('lancedb', 'LanceDB');
    }

    async initialize(_settings) {
        const response = await pluginRequest('/backend/init/lancedb', { method: 'POST' });
        if (!response.ok) {
            const errorBody = await response.text().catch(() => 'No response body');
            throw new Error(`Failed to initialize LanceDB: ${response.status} ${response.statusText} - ${errorBody}`);
        }
        logger.debug('VectHare: Using LanceDB backend (disk-based, scalable)');
    }

    async purgeAllVectorIndexes(settings) {
        const response = await pluginRequest('/collections');
        await this._throwIfFailed(response, 'get collections');
        const data = await response.json();
        for (const collection of data.collections || []) {
            if (collection.backend && collection.backend !== this.type) continue;
            try {
                await this.purgeVectorIndex(collection.id, { ...settings, source: collection.source });
            } catch (error) {
                console.error(`Failed to purge ${collection.id}:`, error);
            }
        }
    }
}
