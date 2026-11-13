/**
 * Writes the settings panel's working copy back to extension_settings.
 */

import { extension_settings } from '../../../../extensions.js';

/**
 * Applies the current settings snapshot without overwriting collection metadata
 * and registry updates written by other UI/code paths while the panel was open.
 * @param {object} settingsSnapshot
 */
export function applySettingsSnapshot(settingsSnapshot) {
    const { collections, vecthare_collection_registry, ...safeSettings } = settingsSnapshot;
    Object.assign(extension_settings.vecthare, safeSettings);
}
