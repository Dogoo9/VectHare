/**
 * ============================================================================
 * VECTHARE - ADVANCED RAG SYSTEM
 * ============================================================================
 * Entry point - lean and clean
 * All logic is in separate modules - see project guidelines
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import {
    eventSource,
    event_types,
} from '../../../../script.js';
import {
    ModuleWorkerWrapper,
    extension_settings,
    getContext,
} from '../../../extensions.js';
import { debounce } from '../../../utils.js';
import { debounce_timeout } from '../../../constants.js';

// VectHare modules - Core
import { synchronizeChat, rearrangeChat, vectorizeAll } from './core/chat-vectorization.js';
import { purgeDeletedChatCollections, tagOpenChatCollections } from './core/chat-cleanup.js';
import { defaultSettings } from './core/default-settings.js';
import { migrateOldEnabledKeys } from './core/collection-metadata.js';
import { clearCollectionRegistry, discoverExistingCollections } from './core/collection-loader.js';
import AsyncUtils from './utils/async-utils.js';

// VectHare modules - UI
import { renderSettings, openDiagnosticsModal, loadWebLlmModels, updateWebLlmStatus, refreshAutoSyncCheckbox } from './ui/ui-manager.js';
import { initializeVisualizer } from './ui/chunk-visualizer.js';
import { initializeDatabaseBrowser } from './ui/database-browser.js';
import { initializeSceneMarkers, setSceneSettings } from './ui/scene-markers.js';
import { initializeWorldInfoIntegration, applySemanticEntriesToPrompt } from './core/world-info-integration.js';
import { pluginRequest } from './backends/similharity-backend.js';
import { configureLogger, logger } from './utils/logger.js';

// VectHare modules - Cotton-Tales Integration
import './core/emotion-classifier.js';
// Runtime settings (merged with saved settings)
const settings = structuredClone(defaultSettings);

// Module worker for automatic syncing
const moduleWorker = new ModuleWorkerWrapper(() => synchronizeChat(settings, getBatchSize()));

// Batch size based on provider
const getBatchSize = () => ['transformers', 'ollama'].includes(settings.source) ? 1 : 5;

// Chat event handler (debounced)
const onChatEvent = debounce(async () => await moduleWorker.update(), debounce_timeout.relaxed);

/**
 * Generation interceptor - searches and injects relevant messages
 */
async function vecthare_rearrangeChat(chat, _contextSize, _abort, type) {
    await rearrangeChat(chat, settings, type);
}

// Export to window for ST to call
window['vecthare_rearrangeChat'] = vecthare_rearrangeChat;

/**
 * Action: Vectorize all messages in current chat
 */
async function onVectorizeAllClick() {
    await vectorizeAll(settings, getBatchSize());
}

/**
 * Action: Full purge - wipes ALL vector data and settings
 */
async function onPurgeClick() {
    const confirmed = confirm(
        'WARNING: This will delete ALL vector data and reset VectHare settings.\n\n' +
        'This cannot be undone. Continue?'
    );

    if (!confirmed) {
        toastr.info('Purge cancelled');
        return;
    }

    try {
        const { saveSettingsDebounced } = await import('../../../../script.js');

        // 1. Delete entire vectors folder (requires the Similharity plugin)
        const response = await pluginRequest('/purge-all', { method: 'POST' });
        if (!response.ok) {
            throw new Error(`Server returned ${response.status} ${response.statusText}. Is the Similharity plugin installed?`);
        }

        // 2. Reset settings in place. Other modules hold a reference to the
        // runtime `settings` object and write it back on every UI change, so
        // clearing only extension_settings would be silently undone.
        for (const key in extension_settings.vecthare) {
            if (key !== 'enabled') {
                delete extension_settings.vecthare[key];
            }
        }
        for (const key of Object.keys(settings)) delete settings[key];
        Object.assign(settings, structuredClone(defaultSettings));
        Object.assign(extension_settings.vecthare, structuredClone(defaultSettings));
        clearCollectionRegistry();

        // 3. Save settings
        saveSettingsDebounced();

        toastr.success('All vector data purged. Reload the page to refresh the settings panel.', 'Purge Complete');

    } catch (error) {
        console.error('VectHare: Purge failed:', error);
        toastr.error('Purge failed: ' + error.message);
    }
}

/**
 * Action: Run diagnostics - opens the diagnostics modal
 */
function onRunDiagnosticsClick() {
    openDiagnosticsModal();
}

/**
 * Initialize VectHare extension
 */
jQuery(async () => {
    logger.debug('VectHare: Initializing...');

    // Load saved settings
    if (!extension_settings.vecthare) {
        extension_settings.vecthare = structuredClone(defaultSettings);
    }

    // Merge saved settings with defaults
    Object.assign(settings, {
        ...structuredClone(defaultSettings),
        ...extension_settings.vecthare,
        temporal_decay: {
            ...defaultSettings.temporal_decay,
            ...extension_settings.vecthare.temporal_decay
        },
        collections: {
            ...defaultSettings.collections,
            ...extension_settings.vecthare.collections
        }
    });

    configureLogger({ level: settings.log_level, content: settings.log_content === true });

    // Migrate old scattered enabled keys to new collections structure
    const migrationResult = migrateOldEnabledKeys();
    if (migrationResult.migrated > 0) {
        logger.debug(`VectHare: Migrated ${migrationResult.migrated} old collection enabled keys`);
    }

    // Render UI
    renderSettings('extensions_settings2', settings, {
        onVectorizeAll: onVectorizeAllClick,
        onPurge: onPurgeClick,
        onRunDiagnostics: onRunDiagnosticsClick
    });

    // Initialize auto-sync checkbox state for current chat (if any)
    refreshAutoSyncCheckbox(settings);

    // Initialize visualizer
    initializeVisualizer();

    // Initialize database browser
    initializeDatabaseBrowser(settings);

    // Initialize scene markers on chat messages (settings needed for DB operations)
    setSceneSettings(settings);
    initializeSceneMarkers();

    // Initialize world info integration hooks
    initializeWorldInfoIntegration();

    // VEC-34: Discover existing collections with retry mechanism
    // Uses exponential backoff to handle temporary backend unavailability
    (async () => {
        try {
            const collections = await AsyncUtils.retry(
                () => discoverExistingCollections(settings),
                {
                    maxAttempts: 3,
                    delay: 2000,
                    maxDelay: 10000,
                    backoffFactor: 2,
                    onRetry: (attempt, error) => {
                        console.warn(`VectHare: Collection discovery attempt ${attempt} failed: ${error.message}. Retrying...`);
                    }
                }
            );
            if (collections.length > 0) {
                logger.debug(`VectHare: Discovered ${collections.length} existing collections`);
            }
        } catch (err) {
            console.error('VectHare: Collection discovery failed after retries:', err.message);
            toastr.warning(
                'Could not discover existing collections. Open Database Browser to refresh manually.',
                'VectHare: Collection Discovery Failed',
                { timeOut: 10000 }
            );
        }
    })();

    // Register event handlers
    eventSource.on(event_types.MESSAGE_DELETED, onChatEvent);
    eventSource.on(event_types.MESSAGE_EDITED, onChatEvent);
    // Run vector sync tasks on message events
    // Semantic WI injection runs after SillyTavern's keyword scan, below.
    eventSource.on(event_types.MESSAGE_SENT, onChatEvent);
    eventSource.on(event_types.MESSAGE_RECEIVED, onChatEvent);
    eventSource.on(event_types.MESSAGE_SWIPED, onChatEvent);
    // Hook the final World Info scan loop: keyword activation is authoritative
    // here, and the awaited event completes before ST assembles the prompt.
    if (event_types.WORLDINFO_SCAN_DONE) {
        eventSource.on(event_types.WORLDINFO_SCAN_DONE, async (scan) => {
            if (scan?.state?.next) return;
            await applySemanticEntriesToPrompt(
                getContext().chat || [],
                settings,
                scan?.activated?.entries,
            );
        });
    }
    // When a chat is deleted, remove the collections that were built from it
    const onChatDeleted = async (chatId) => {
        if (!chatId) return;
        try {
            const deleted = await purgeDeletedChatCollections(chatId, settings);
            if (deleted.length > 0) {
                logger.info(`VectHare: Removed ${deleted.length} collection(s) for deleted chat: ${chatId}`);
            }
        } catch (error) {
            console.warn(`VectHare: Failed to purge vectors for deleted chat ${chatId}:`, error);
        }
    };
    eventSource.on(event_types.CHAT_DELETED, onChatDeleted);
    eventSource.on(event_types.GROUP_CHAT_DELETED, onChatDeleted);

    // When WebLLM extension is loaded, refresh the model list
    eventSource.on(event_types.EXTENSION_SETTINGS_LOADED, async (manifest) => {
        if (settings.source === 'webllm' && manifest?.display_name === 'WebLLM') {
            logger.debug('VectHare: WebLLM extension loaded, refreshing models...');
            updateWebLlmStatus();
            await loadWebLlmModels(settings);
        }
    });

    // When chat changes, refresh UI state to match settings
    eventSource.on(event_types.CHAT_CHANGED, () => {
        logger.debug('VectHare: Chat changed, refreshing UI state');
        refreshAutoSyncCheckbox(settings);
        tagOpenChatCollections();
    });

    logger.info('Initialized successfully');
});
