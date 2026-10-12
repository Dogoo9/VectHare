import { getBackend } from '../backends/backend-manager.js';
import { storageSettings } from './collection-portability.js';

/** Storage-only enumeration: initialization must not call an inference service. */
export async function getStorageHashes(id, settings) {
    const routed = { ...storageSettings(settings), _storageReadOnly: true };
    const backend = await getBackend(routed);
    // Adapter implementations without pagination have a complete native hash list.
    if (!backend.listChunks) return backend.getSavedHashes(id, routed);
    const hashes = [];
    let total;
    while (total === undefined || hashes.length < total) {
        const data = await backend.listChunks(id, routed, { offset: hashes.length, limit: 500 });
        if (!Array.isArray(data?.items) || !Number.isInteger(data.total) || data.total < 0) throw new Error('Storage did not provide a complete chunk count.');
        if (total !== undefined && total !== data.total) throw new Error('Collection changed during storage enumeration. Retry the snapshot.');
        total = data.total;
        if (!data.items.length && hashes.length < total) throw new Error('Storage hash enumeration is incomplete.');
        hashes.push(...data.items.map(i => i.hash ?? i.metadata?.hash));
    }
    if (hashes.length !== total || hashes.some(h => h === undefined) || new Set(hashes.map(String)).size !== hashes.length) throw new Error('Storage has duplicate or incomplete stable identifiers.');
    return hashes;
}
