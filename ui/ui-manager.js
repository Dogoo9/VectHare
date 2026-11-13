/**
 * ============================================================================
 * VECTHARE UI MANAGER
 * ============================================================================
 * Handles ALL UI rendering and event binding
 * Keeps index.js clean and lean
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import { saveSettingsDebounced, getCurrentChatId } from '../../../../../script.js';
import { openThirdPartyExtensionMenu } from '../../../../extensions.js';
import { writeSecret, SECRET_KEYS, secret_state, readSecretState } from '../../../../secrets.js';
import { openDatabaseBrowser } from './database-browser.js';
import { openContentVectorizer } from './content-vectorizer.js';
import { openSearchDebugModal } from './search-debug.js';
import { openTextCleaningManager } from './text-cleaning-manager.js';
import { resetBackendHealth } from '../backends/backend-manager.js';
import { initializeHealthDashboard } from './health-dashboard.js';
import { getChatCollectionId } from '../core/chat-vectorization.js';
import { doesChatHaveVectors } from '../core/collection-loader.js';
import { getChunkingStrategies } from '../core/content-types.js';
import { bindAlternativeEndpointControls } from './endpoint-presets.js';
import { configureLogger, logger } from '../utils/logger.js';
import { getSettingsHtml } from './settings-template.js';
import { applySettingsSnapshot } from './settings-store.js';
import { initializeDiagnosticsModal } from './diagnostics-modal.js';
import { isWebLlmSupported, executeWithWebLlmErrorHandling, getWebLlmProvider, loadWebLlmModels, updateWebLlmStatus } from './webllm-ui.js';
import { initializeCottonTalesIntegration } from './cotton-tales-ui.js';

/**
 * Renders the VectHare settings UI
 * @param {string} containerId - The container element ID to render into
 * @param {object} settings - VectHare settings object
 * @param {object} callbacks - Object containing callback functions
 * @param {Function} callbacks.onVectorizeAll - Called when "Vectorize All" is clicked
 * @param {Function} callbacks.onPurge - Called when "Purge" is clicked
 * @param {Function} callbacks.onRunDiagnostics - Called when "Run Diagnostics" is clicked
 */
export function renderSettings(containerId, settings, callbacks) {
    logger.debug('VectHare UI: Rendering settings...');

    $(`#${containerId}`).append(getSettingsHtml());

    // Bind all events
    bindSettingsEvents(settings, callbacks);

    // Initialize collapsible cards
    initializeCollapsibleCards();

    // Initialize modal
    initializeDiagnosticsModal();

    // Initialize health dashboard
    initializeHealthDashboard();

    logger.debug('VectHare UI: Settings rendered');
}

/**
 * Initializes collapsible functionality
 */
function initializeCollapsibleCards() {
    $('.vecthare-collapsible-header').on('click', function() {
        const content = $(this).next('.vecthare-collapsible-content');
        const icon = $(this).find('.vecthare-collapsible-icon');

        content.slideToggle(200);
        icon.toggleClass('rotated');
    });
}

/**
 * Updates the WebLLM status display based on availability
 * @returns {boolean} True if WebLLM is available
 */
/**
 * Refreshes the auto-sync checkbox state from current chat's collection
 * Call this when chat changes to keep UI in sync
 * @param {object} settings - VectHare settings object (unused, kept for API compatibility)
 */
export function refreshAutoSyncCheckbox(settings) {
    const collectionId = getChatCollectionId();
    if (!collectionId) {
        $('#vecthare_autosync_enabled').prop('checked', false);
        return;
    }
    // Dynamically import to avoid circular dependency
    import('../core/collection-metadata.js').then(({ isCollectionAutoSyncEnabled }) => {
        const isEnabled = isCollectionAutoSyncEnabled(collectionId);
        $('#vecthare_autosync_enabled').prop('checked', isEnabled);
    });
}

/**
 * Toggles provider-specific settings visibility
 * @param {string} selectedProvider - Currently selected provider
 * @param {object} settings - VectHare settings object
 */
function toggleProviderSettings(selectedProvider, settings) {
    // Hide all provider-specific settings
    $('.vecthare_provider_setting').hide();

    // Show settings for selected provider
    $(`.vecthare_provider_setting`).each(function() {
        const providers = $(this).attr('data-provider').split(',');
        if (providers.includes(selectedProvider)) {
            $(this).show();
        }
    });

    // Handle WebLLM-specific initialization
    if (selectedProvider === 'webllm') {
        const isSupported = updateWebLlmStatus();
        if (isSupported) {
            loadWebLlmModels(settings);
        }
    }
}

/**
 * Shows a confirmation modal when enabling auto-sync on a chat with existing vectors
 * If multiple collections match, lets user pick which one to use
 * @param {Array} allMatches - Array of matching collections [{collectionId, registryKey, chunkCount, source, backend}]
 * @param {object} settings - VectHare settings for purge operations
 * @returns {Promise<{action: string, selectedCollection?: object}>} User's choice
 */
async function showAutoSyncConfirmModal(allMatches, settings) {
    // Import unified delete function for ghost cleanup
    const { deleteCollection } = await import('../core/collection-loader.js');

    return new Promise((resolve) => {
        const hasMultiple = allMatches.length > 1;
        const hasGhosts = allMatches.some(m => m.chunkCount === 0);

        // Build collection list HTML
        const collectionListHtml = allMatches.map((match, index) => {
            const displayId = match.collectionId.length > 35
                ? match.collectionId.substring(0, 18) + '...' + match.collectionId.substring(match.collectionId.length - 12)
                : match.collectionId;
            const isGhost = match.chunkCount === 0;
            const isRecommended = index === 0 && !isGhost;

            return `
                <div class="vecthare-collection-option ${isGhost ? 'ghost' : ''}" data-index="${index}" style="
                    background: var(--SmartThemeBlurTintColor);
                    padding: 12px;
                    border-radius: 8px;
                    margin-bottom: 10px;
                    cursor: pointer;
                    border: 2px solid ${isRecommended ? 'var(--SmartThemeQuoteColor)' : 'transparent'};
                    opacity: ${isGhost ? '0.6' : '1'};
                    position: relative;
                ">
                    ${isRecommended ? '<span style="position: absolute; top: -8px; right: 10px; background: var(--SmartThemeQuoteColor); color: var(--SmartThemeBodyColor); font-size: 0.7em; padding: 2px 6px; border-radius: 4px;">RECOMMENDED</span>' : ''}
                    ${isGhost ? '<span style="position: absolute; top: -8px; right: 10px; background: var(--SmartThemeFontColorOverrideWarning, #f0ad4e); color: #000; font-size: 0.7em; padding: 2px 6px; border-radius: 4px;">GHOST</span>' : ''}
                    <div style="display: flex; justify-content: space-between; align-items: start;">
                        <div style="flex: 1; min-width: 0;">
                            <div style="font-family: monospace; word-break: break-all; font-size: 0.85em; margin-bottom: 6px;">
                                ${displayId}
                            </div>
                            <div style="font-size: 0.8em; color: var(--SmartThemeQuoteColor);">
                                <i class="fa-solid fa-cube"></i> <strong>${match.chunkCount}</strong> chunks
                                ${match.source ? `<span style="margin-left: 10px;"><i class="fa-solid fa-database"></i> ${match.source}</span>` : ''}
                            </div>
                        </div>
                        ${isGhost ? `
                            <button class="menu_button menu_button_icon vecthare-delete-ghost" data-index="${index}" style="margin-left: 10px; color: var(--SmartThemeFontColorOverrideWarning, #f0ad4e);" title="Delete this ghost collection">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        }).join('');

        const modalHtml = `
            <div id="vecthare_autosync_confirm_modal" class="vecthare-modal" style="display: flex;">
                <div class="vecthare-modal-content" style="max-width: 500px;">
                    <div class="vecthare-modal-header">
                        <h3><i class="fa-solid fa-link"></i> ${hasMultiple ? 'Multiple Collections Found' : 'Existing Collection Found'}</h3>
                        <button class="vecthare-modal-close" data-action="cancel">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                    <div class="vecthare-modal-body" style="padding: 20px;">
                        <p style="margin-bottom: 15px;">
                            ${hasMultiple
                                ? `Found <strong>${allMatches.length}</strong> collections matching this chat.${hasGhosts ? ' <span style="color: var(--SmartThemeFontColorOverrideWarning, #f0ad4e);">Ghost collections (0 chunks) can be deleted.</span>' : ''}`
                                : 'This chat already has a vectorized collection:'}
                        </p>
                        <div style="max-height: 300px; overflow-y: auto; margin-bottom: 15px;">
                            ${collectionListHtml}
                        </div>
                        <p style="margin-bottom: 10px; font-size: 0.9em; color: var(--SmartThemeQuoteColor);">
                            ${hasMultiple ? 'Click a collection to select it, then choose an action.' : 'What would you like to do?'}
                        </p>
                    </div>
                    <div class="vecthare-modal-footer" style="display: flex; gap: 10px; padding: 15px 20px; border-top: 1px solid var(--SmartThemeBorderColor);">
                        <button class="menu_button" data-action="reconnect" style="flex: 1;">
                            <i class="fa-solid fa-plug"></i> Connect
                        </button>
                        <button class="menu_button" data-action="revectorize" style="flex: 1;">
                            <i class="fa-solid fa-rotate"></i> Re-vectorize
                        </button>
                        <button class="menu_button menu_button_icon" data-action="cancel">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;

        const $modal = $(modalHtml);
        $('body').append($modal);

        // Track selected collection (default to first/best)
        let selectedIndex = 0;
        $modal.find('.vecthare-collection-option').first().css('border-color', 'var(--SmartThemeQuoteColor)');

        // Handle collection selection
        $modal.find('.vecthare-collection-option').on('click', function(e) {
            if ($(e.target).closest('.vecthare-delete-ghost').length) return; // Don't select when clicking delete

            selectedIndex = parseInt($(this).data('index'));
            $modal.find('.vecthare-collection-option').css('border-color', 'transparent');
            $(this).css('border-color', 'var(--SmartThemeQuoteColor)');
        });

        // Handle ghost deletion - uses unified deleteCollection()
        $modal.find('.vecthare-delete-ghost').on('click', async function(e) {
            e.stopPropagation();
            const index = parseInt($(this).data('index'));
            const ghost = allMatches[index];

            if (!confirm(`Delete ghost collection?\n\n${ghost.collectionId}\n\nThis will remove it from disk.`)) return;

            try {
                // Use unified delete function - handles vectors, registry, AND metadata
                const deleteSettings = {
                    ...settings,
                    source: ghost.source || settings.source,
                };
                const result = await deleteCollection(ghost.collectionId, deleteSettings, ghost.registryKey);

                // Remove from UI
                allMatches.splice(index, 1);
                $(this).closest('.vecthare-collection-option').fadeOut(200, function() {
                    $(this).remove();
                    // Re-index remaining items
                    $modal.find('.vecthare-collection-option').each((i, el) => {
                        $(el).attr('data-index', i);
                        $(el).find('.vecthare-delete-ghost').attr('data-index', i);
                    });
                });

                if (result.success) {
                    toastr.success('Ghost collection deleted', 'VectHare');
                } else {
                    toastr.warning(`Partial deletion: ${result.errors.join(', ')}`, 'VectHare');
                }

                // If no collections left, close modal
                if (allMatches.length === 0) {
                    $modal.remove();
                    resolve({ action: 'revectorize' });
                } else if (selectedIndex >= allMatches.length) {
                    selectedIndex = 0;
                    $modal.find('.vecthare-collection-option').first().css('border-color', 'var(--SmartThemeQuoteColor)');
                }
            } catch (error) {
                console.error('VectHare: Failed to delete ghost', error);
                toastr.error('Failed to delete ghost collection', 'VectHare');
            }
        });

        // Handle action buttons
        $modal.find('[data-action]').on('click', function() {
            const action = $(this).data('action');
            $modal.remove();
            resolve({
                action,
                selectedCollection: action === 'reconnect' ? allMatches[selectedIndex] : null
            });
        });

        // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
        $modal.on('mousedown touchstart', function(e) {
            e.stopPropagation();
        });

        // Close on background click
        $modal.on('click', function(e) {
            if (e.target === this) {
                $modal.remove();
                resolve({ action: 'cancel' });
            }
        });

        // Handle escape key
        $(document).one('keydown.autosync_modal', function(e) {
            if (e.key === 'Escape') {
                $modal.remove();
                resolve({ action: 'cancel' });
            }
        });
    });
}

/**
 * Binds event handlers to UI elements
 * @param {object} settings - VectHare settings object
 * @param {object} callbacks - Callback functions
 */
function bindSettingsEvents(settings, callbacks) {
    // Auto-sync enable/disable - now per-collection instead of global
    // Initial state is set by refreshAutoSyncCheckbox() after chat loads
    $('#vecthare_autosync_enabled')
        .on('input', async function() {
            const enabling = $(this).prop('checked');
            const $checkbox = $(this);

            const chatId = getCurrentChatId();
            if (!chatId) {
                // No chat open - warn and don't enable
                toastr.warning('Open a chat first before enabling auto-sync');
                $checkbox.prop('checked', false);
                return;
            }

            const collectionId = getChatCollectionId();
            if (!collectionId) {
                toastr.warning('Could not get collection ID for this chat');
                $checkbox.prop('checked', false);
                return;
            }

            // Import the metadata functions
            const { setCollectionAutoSync } = await import('../core/collection-metadata.js');

            // If enabling, check if we need to set up the collection first
            if (enabling) {
                // SINGLE SOURCE OF TRUTH: Use doesChatHaveVectors which runs discovery
                const { hasVectors, allMatches } = await doesChatHaveVectors(settings);

                if (!hasVectors) {
                    // Preserve the user's choice while they create the initial
                    // index. Previously this branch reset the checkbox and
                    // never enabled auto-sync after opening the vectorizer, so
                    // future chat messages were silently left out.
                    setCollectionAutoSync(collectionId, true);
                    $checkbox.prop('checked', true);
                    toastr.info('Set up the initial chat index. Auto-sync will keep it updated afterward.');
                    openContentVectorizer('chat');
                    return;
                }

                // Found existing vectors - show confirmation modal with all matches
                const result = await showAutoSyncConfirmModal(allMatches, settings);

                if (result.action === 'cancel') {
                    // User cancelled - don't enable
                    $checkbox.prop('checked', false);
                    return;
                }

                if (result.action === 'reconnect' && result.selectedCollection) {
                    // Connect to selected collection
                    const selected = result.selectedCollection;
                    toastr.success(`Connected to collection with ${selected.chunkCount} chunks`, 'Auto-Sync Enabled');
                    logger.debug(`VectHare: Auto-sync enabled - connected to ${selected.collectionId} (${selected.chunkCount} chunks)`);
                } else if (result.action === 'revectorize') {
                    // User wants to start fresh - open vectorizer
                    $checkbox.prop('checked', false);
                    openContentVectorizer('chat');
                    return;
                }
            }

            // Save to per-collection metadata instead of global setting
            setCollectionAutoSync(collectionId, enabling);

            if (!enabling) {
                toastr.info('Auto-sync disabled for this chat');
            } else {
                toastr.success('Auto-sync enabled for this chat');
            }
            logger.debug(`VectHare: Chat auto-sync for ${collectionId}: ${enabling ? 'enabled' : 'disabled'}`);
        });

        // Collection lock handled inside Database Browser per-collection settings

    // Chunking strategy - populate from content-types.js (single source of truth)
    const chatStrategies = getChunkingStrategies('chat');
    const strategySelect = $('#vecthare_chunking_strategy');
    strategySelect.empty();
    for (const strategy of chatStrategies) {
        const selected = strategy.id === (settings.chunking_strategy || 'per_message');
        strategySelect.append(`<option value="${strategy.id}" ${selected ? 'selected' : ''}>${strategy.name}</option>`);
    }

    function updateStrategyUI(strategyId) {
        // Update description from content-types.js
        const strategy = chatStrategies.find(s => s.id === strategyId);
        $('#vecthare_strategy_description').text(strategy?.description || '');
        // Show/hide batch settings
        $('#vecthare_batch_settings').toggle(strategyId === 'message_batch');
    }

    strategySelect.on('change', function() {
        settings.chunking_strategy = String($(this).val());
        applySettingsSnapshot(settings);
        saveSettingsDebounced();
        updateStrategyUI(settings.chunking_strategy);
    });
    updateStrategyUI(settings.chunking_strategy || 'per_message');

    // Batch size (for message_batch strategy)
    $('#vecthare_batch_size')
        .val(settings.batch_size || 4)
        .on('input', function() {
            const value = Number($(this).val());
            $('#vecthare_batch_size_value').text(value);
            settings.batch_size = value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_batch_size_value').text(settings.batch_size || 4);

    // Chunk size (for adaptive strategy)
    $('#vecthare_chunk_size')
        .val(settings.chunk_size || 500)
        .on('input', function() {
            const value = Number($(this).val());
            settings.chunk_size = value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Vector backend selection
    $('#vecthare_vector_backend')
        .val(settings.vector_backend || 'standard')
        .on('change', function() {
            settings.vector_backend = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();

            // Show/hide Qdrant settings
            if (settings.vector_backend === 'qdrant') {
                $('#vecthare_qdrant_settings').show();
            } else {
                $('#vecthare_qdrant_settings').hide();
            }
            if (settings.vector_backend === 'milvus') {
                $('#vecthare_milvus_settings').show();
            } else {
                $('#vecthare_milvus_settings').hide();
            }

            logger.debug(`VectHare: Vector backend changed to ${settings.vector_backend}`);
            // Reset health cache so new backend gets properly initialized
            resetBackendHealth();
        });

    // Qdrant cloud toggle
    $('#vecthare_qdrant_use_cloud')
        .prop('checked', settings.qdrant_use_cloud || false)
        .on('change', async function() {
            settings.qdrant_use_cloud = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();

            // Toggle between local and cloud settings
            if (settings.qdrant_use_cloud) {
                $('#vecthare_qdrant_local_settings').hide();
                $('#vecthare_qdrant_cloud_settings').show();
            } else {
                $('#vecthare_qdrant_local_settings').show();
                $('#vecthare_qdrant_cloud_settings').hide();
            }

            // Reset backend health to force re-initialization with new config
            logger.debug('VectHare: Qdrant mode changed, forcing re-initialization...');
            resetBackendHealth('qdrant');

            // Proactively reinitialize if Qdrant is the current backend
            if (settings.vector_backend === 'qdrant') {
                try {
                    const { initializeBackend } = await import('../backends/backend-manager.js');
                    await initializeBackend('qdrant', settings, false);
                    toastr.success(
                        `Qdrant re-initialized in ${settings.qdrant_use_cloud ? 'cloud' : 'local'} mode`,
                        'VectHare'
                    );
                } catch (e) {
                    console.error('VectHare: Failed to reinitialize Qdrant:', e);
                    toastr.warning('Failed to reinitialize Qdrant: ' + e.message, 'VectHare');
                }
            }
        })
        .trigger('change');

    // Qdrant settings
    $('#vecthare_qdrant_host')
        .val(settings.qdrant_host || 'localhost')
        .on('input', function() {
            settings.qdrant_host = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_qdrant_port')
        .val(settings.qdrant_port || 6333)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.qdrant_port = isNaN(value) ? 6333 : value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_qdrant_url')
        .val(settings.qdrant_url || '')
        .on('input', function() {
            settings.qdrant_url = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_qdrant_api_key')
        .val(settings.qdrant_api_key || '')
        .on('input', function() {
            settings.qdrant_api_key = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Qdrant multitenancy toggle
    $('#vecthare_qdrant_multitenancy')
        .prop('checked', settings.qdrant_multitenancy || false)
        .on('change', function() {
            settings.qdrant_multitenancy = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Show Qdrant settings if backend is qdrant
    if (settings.vector_backend === 'qdrant') {
        $('#vecthare_qdrant_settings').show();
    }

    // Milvus settings
    $('#vecthare_milvus_host')
        .val(settings.milvus_host || 'localhost')
        .on('input', function() {
            settings.milvus_host = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_port')
        .val(settings.milvus_port || 19530)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.milvus_port = isNaN(value) ? 19530 : value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_username')
        .val(settings.milvus_username || '')
        .on('input', function() {
            settings.milvus_username = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_password')
        .val(settings.milvus_password || '')
        .on('input', function() {
            settings.milvus_password = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_token')
        .val(settings.milvus_token || '')
        .on('input', function() {
            settings.milvus_token = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_dimensions')
        .val(settings.milvus_dimensions || '')
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.milvus_dimensions = isNaN(value) ? '' : value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_milvus_address')
        .val(settings.milvus_address || '')
        .on('input', function() {
            settings.milvus_address = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Show Milvus settings if backend is milvus
    if (settings.vector_backend === 'milvus') {
        $('#vecthare_milvus_settings').show();
    }

    // Embedding provider
    $('#vecthare_source')
        .val(settings.source)
        .on('change', function() {
            settings.source = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            toggleProviderSettings(settings.source, settings);
            logger.debug(`VectHare: Embedding provider changed to ${settings.source}`);
            // Reset health cache since provider change may affect backend connectivity
            resetBackendHealth();
        });

    // Score threshold
    $('#vecthare_score_threshold')
        .val(settings.score_threshold)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.3 : value;
            $('#vecthare_threshold_value').text(safeValue.toFixed(2));
            settings.score_threshold = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_threshold_value').text(settings.score_threshold.toFixed(2));

    // Deduplication depth
    $('#vecthare_deduplication_depth')
        .val(settings.deduplication_depth ?? 50)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 50 : Math.max(0, value);
            $('#vecthare_deduplication_depth_value').text(safeValue);
            settings.deduplication_depth = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_deduplication_depth_value').text(settings.deduplication_depth ?? 50);

    // Keyword scoring method
    $('#vecthare_keyword_scoring_method')
        .val(settings.keyword_scoring_method || 'keyword')
        .on('change', function() {
            settings.keyword_scoring_method = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();

            // Show/hide BM25 parameters
            if (settings.keyword_scoring_method === 'bm25' || settings.keyword_scoring_method === 'hybrid') {
                $('#vecthare_bm25_params').show();
            } else {
                $('#vecthare_bm25_params').hide();
            }
            logger.debug(`VectHare: Keyword scoring method changed to ${settings.keyword_scoring_method}`);
        });

    // Show/hide BM25 params based on initial setting
    if (settings.keyword_scoring_method === 'bm25' || settings.keyword_scoring_method === 'hybrid') {
        $('#vecthare_bm25_params').show();
    }

    // BM25 k1 parameter
    $('#vecthare_bm25_k1')
        .val(settings.bm25_k1 || 1.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 1.5 : value;
            $('#vecthare_bm25_k1_value').text(safeValue.toFixed(1));
            settings.bm25_k1 = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_bm25_k1_value').text((settings.bm25_k1 || 1.5).toFixed(1));

    // BM25 b parameter
    $('#vecthare_bm25_b')
        .val(settings.bm25_b || 0.75)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.75 : value;
            $('#vecthare_bm25_b_value').text(safeValue.toFixed(2));
            settings.bm25_b = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_bm25_b_value').text((settings.bm25_b || 0.75).toFixed(2));

    // ========== Hybrid Search Settings ==========

    // Enable Hybrid Search checkbox
    $('#vecthare_hybrid_search_enabled')
        .prop('checked', settings.hybrid_search_enabled || false)
        .on('change', function() {
            const enabled = $(this).prop('checked');
            settings.hybrid_search_enabled = enabled;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            $('#vecthare_hybrid_params').toggle(enabled);
            logger.debug(`VectHare: Hybrid search ${enabled ? 'enabled' : 'disabled'}`);
        });
    // Initialize visibility
    $('#vecthare_hybrid_params').toggle(settings.hybrid_search_enabled || false);

    // Fusion method selector
    $('#vecthare_hybrid_fusion_method')
        .val(settings.hybrid_fusion_method || 'heuristic_weighted')
        .on('change', function() {
            settings.hybrid_fusion_method = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            // Show weights only for weighted method, RRF settings for RRF
            const isWeighted = settings.hybrid_fusion_method === 'weighted';
            $('#vecthare_hybrid_weights').toggle(isWeighted);
            $('#vecthare_hybrid_rrf_settings').toggle(!isWeighted);
            logger.debug(`VectHare: Hybrid fusion method changed to ${settings.hybrid_fusion_method}`);
        });
    // Initialize visibility based on current method
    const isWeightedMethod = (settings.hybrid_fusion_method || 'heuristic_weighted') === 'weighted';
    $('#vecthare_hybrid_weights').toggle(isWeightedMethod);
    $('#vecthare_hybrid_rrf_settings').toggle(!isWeightedMethod);

    // Vector weight slider
    $('#vecthare_hybrid_vector_weight')
        .val(settings.hybrid_vector_weight ?? 0.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.5 : value;
            $('#vecthare_hybrid_vector_weight_value').text(safeValue.toFixed(1));
            settings.hybrid_vector_weight = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_hybrid_vector_weight_value').text((settings.hybrid_vector_weight ?? 0.5).toFixed(1));

    // Text weight slider
    $('#vecthare_hybrid_text_weight')
        .val(settings.hybrid_text_weight ?? 0.5)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.5 : value;
            $('#vecthare_hybrid_text_weight_value').text(safeValue.toFixed(1));
            settings.hybrid_text_weight = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_hybrid_text_weight_value').text((settings.hybrid_text_weight ?? 0.5).toFixed(1));

    // RRF K constant slider
    $('#vecthare_hybrid_rrf_k')
        .val(settings.hybrid_rrf_k || 60)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 60 : value;
            $('#vecthare_hybrid_rrf_k_value').text(safeValue);
            settings.hybrid_rrf_k = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_hybrid_rrf_k_value').text(settings.hybrid_rrf_k || 60);

    // Prefer native backend hybrid checkbox
    $('#vecthare_hybrid_native_prefer')
        .prop('checked', settings.hybrid_native_prefer !== false)
        .on('change', function() {
            settings.hybrid_native_prefer = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Query depth (how many recent messages to include in search query)
    $('#vecthare_query_depth')
        .val(settings.query || 2)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 2 : value;
            $('#vecthare_query_depth_value').text(safeValue);
            settings.query = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_query_depth_value').text(settings.query || 2);

    // Top K - number of results retrieved per collection (top-K)
    $('#vecthare_topk')
        .val((settings.top_k ?? settings.insert) || 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? (settings.insert || 3) : Math.max(1, Math.min(500, value));
            $('#vecthare_topk_value').text(safeValue);
            settings.top_k = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_topk_value').text((settings.top_k ?? settings.insert) || 3);

    const defaultCandidateK = Math.min(500, Math.max(
        ((settings.top_k ?? settings.insert) || 3) * 4,
        ((settings.top_k ?? settings.insert) || 3) + 20,
    ));
    $('#vecthare_candidate_k')
        .val(settings.candidate_k ?? defaultCandidateK)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? defaultCandidateK : Math.max(1, Math.min(500, value));
            $('#vecthare_candidate_k_value').text(safeValue);
            settings.candidate_k = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_candidate_k_value').text(settings.candidate_k ?? defaultCandidateK);

    // World Info Integration settings
    $('#vecthare_enabled_world_info')
        .prop('checked', settings.enabled_world_info || false)
        .on('change', function() {
            const enabled = $(this).prop('checked');
            settings.enabled_world_info = enabled;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            // Show/hide the detailed world info settings panel
            $('#vecthare_world_info_settings').toggle(enabled);
        });

    $('#vecthare_world_info_threshold')
        .val(settings.world_info_threshold ?? 0.3)
        .on('input', function() {
            const value = parseFloat($(this).val());
            const safeValue = isNaN(value) ? 0.3 : Math.max(0, Math.min(1, value));
            settings.world_info_threshold = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_world_info_top_k')
        .val(settings.world_info_top_k ?? 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 3 : Math.max(1, Math.min(20, value));
            settings.world_info_top_k = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_world_info_query_depth')
        .val(settings.world_info_query_depth ?? 3)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 3 : Math.max(1, Math.min(10, value));
            settings.world_info_query_depth = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_enabled_for_all')
        .prop('checked', settings.world_info_enabled_for_all || false)
        .on('change', function() {
            settings.world_info_enabled_for_all = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_max_entries')
        .val(settings.world_info_max_entries ?? 10)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.world_info_max_entries = isNaN(value) ? 10 : Math.max(1, Math.min(9999, value));
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Custom stopwords
    $('#vecthare_custom_stopwords')
        .val(settings.custom_stopwords || '')
        .on('input', function() {
            settings.custom_stopwords = $(this).val();
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Initialize world info settings visibility based on current setting
    $('#vecthare_world_info_settings').toggle(settings.enabled_world_info || false);

    // Debug buttons: Test semantic WI and dump registry
    $('#vecthare_wi_test_btn').on('click', async function() {
        try {
            const raw = $('#vecthare_wi_test_input').val() || '';
            const recentMessages = raw.split('\n').map(s => s.trim()).filter(Boolean);
            const activeEntries = [];
            const cfg = window.extension_settings?.vecthare || settings;

            logger.debug('VectHare: Running semantic WI test with messages:', recentMessages);

            // Primary: use initialized hooks if available
            if (window.VectHare_WorldInfo && typeof window.VectHare_WorldInfo.getSemanticEntries === 'function') {
                const entries = await window.VectHare_WorldInfo.getSemanticEntries(recentMessages, activeEntries, cfg);
                logger.debug('VectHare: Semantic WI test results (via window hooks):', entries);
                toastr.info(`Semantic WI test completed - ${entries.length} entries (see console)`);

                // If no entries found, provide extended diagnostics to help debug
                if (!entries || entries.length === 0) {
                    try {
                        logger.debug('VectHare: No semantic entries — dumping registry and per-collection query info...');
                        const registry = window.extension_settings?.vecthare?.vecthare_collection_registry || settings.vecthare_collection_registry || [];
                        logger.debug('VectHare: Collection registry:', registry);

                        const coreApi = await import('../core/core-vector-api.js');
                        const metaMod = await import('../core/collection-metadata.js');

                        for (const collKey of registry) {
                            try {
                                if (!collKey.includes('lorebook')) continue; // focus on lorebooks
                                const meta = metaMod.getCollectionMeta(collKey);
                                logger.debug(`VectHare: Collection meta for ${collKey}:`, meta);

                                // Check saved hashes (true=include metadata)
                                if (coreApi.getSavedHashes) {
                                    try {
                                        const saved = await coreApi.getSavedHashes(collKey, cfg, true);
                                        logger.debug(`VectHare: getSavedHashes for ${collKey}:`, saved && saved.hashes ? saved.hashes.length + ' hashes' : saved);
                                    } catch (hErr) {
                                        console.warn(`VectHare: getSavedHashes failed for ${collKey}:`, hErr.message);
                                    }
                                }

                                // Run a direct vector query against this collection
                                try {
                                    const qres = await coreApi.queryCollection(collKey, recentMessages.join('\n'), cfg.world_info_top_k || 3, cfg);
                                    logger.debug(`VectHare: queryCollection result for ${collKey}:`, qres);
                                } catch (qErr) {
                                    console.warn(`VectHare: queryCollection failed for ${collKey}:`, qErr.message);
                                }
                            } catch (inner) {
                                console.warn('VectHare: Error inspecting collection', collKey, inner.message);
                            }
                        }

                        toastr.info('Extended WI diagnostics written to console (registry + per-collection queries)');
                    } catch (diagErr) {
                        console.error('VectHare: Failed to run extended WI diagnostics', diagErr);
                        toastr.error('Failed to run WI diagnostics: ' + (diagErr.message || diagErr));
                    }
                }

                return;
            }

            // Fallback: try dynamic import of module (in case initialization order differed)
            try {
                const mod = await import('../core/world-info-integration.js');
                const fn = mod.getSemanticWorldInfoEntries || mod.getSemanticEntries || mod.default;
                if (!fn || typeof fn !== 'function') {
                    throw new Error('WorldInfo module does not export a usable function');
                }
                const entries = await fn(recentMessages, activeEntries, cfg);
                logger.debug('VectHare: Semantic WI test results (via dynamic import):', entries);
                toastr.info(`Semantic WI test completed - ${entries.length} entries (see console)`);
                return;
            } catch (impErr) {
                console.warn('VectHare: Dynamic import fallback failed:', impErr.message);
                toastr.error('VectHare: WorldInfo hooks not initialized and dynamic import failed: ' + impErr.message);
                return;
            }

        } catch (e) {
            console.error('VectHare: Semantic WI test failed', e);
            try { toastr.error('Semantic WI test failed: ' + (e.message || String(e))); } catch (_) {}
        }
    });

    $('#vecthare_wi_dump_registry').on('click', function() {
        try {
            const registry = window.extension_settings?.vecthare?.vecthare_collection_registry || settings.vecthare_collection_registry || [];
            logger.debug('VectHare: Collection registry dump:', registry);
            toastr.info(`Collection registry dumped to console (${registry.length} items)`);
        } catch (e) {
            console.error('VectHare: Failed to dump registry', e);
            toastr.error('Failed to dump registry: ' + e.message);
        }
    });

    // Apply first semantic hit to ST World Info (best-effort)
    $('#vecthare_wi_apply_first').on('click', async function() {
        try {
            const raw = $('#vecthare_wi_test_input').val() || '';
            const recentMessages = raw.split('\n').map(s => s.trim()).filter(Boolean);
            const cfg = window.extension_settings?.vecthare || settings;

            if (!window.VectHare_WorldInfo || !window.VectHare_WorldInfo.getSemanticEntries) {
                toastr.error('VectHare: WorldInfo hooks not initialized');
                return;
            }

            const entries = await window.VectHare_WorldInfo.getSemanticEntries(recentMessages, [], cfg);
            if (!entries || entries.length === 0) {
                toastr.info('No semantic entries found');
                return;
            }

            const first = entries[0];
            logger.debug('VectHare: Applying semantic WI entry:', first);

            // Best-effort: try importing ST's world-info module and invoking common APIs
            let applied = false;
            try {
                const worldInfo = await import('../../../../world-info.js');
                // Try common function names
                const candidates = ['applyWorldInfoEntries', 'activateEntries', 'setActiveEntries', 'activateWorldInfoEntries'];
                for (const name of candidates) {
                    if (worldInfo[name] && typeof worldInfo[name] === 'function') {
                        await worldInfo[name]([first]);
                        applied = true;
                        logger.debug(`VectHare: Applied via world-info.${name}`);
                        break;
                    }
                }
            } catch (e) {
                logger.debug('VectHare: world-info import failed or method not found', e);
            }

            // Try global window API fallbacks
            if (!applied) {
                const fallbackCandidates = [
                    window.applyWorldInfoEntries,
                    window.activateWorldInfoEntries,
                    window.setActiveWorldInfoEntries
                ];
                for (const fn of fallbackCandidates) {
                    if (fn && typeof fn === 'function') {
                        try {
                            await fn([first]);
                            applied = true;
                            logger.debug('VectHare: Applied via global fallback function');
                            break;
                        } catch (e) {
                            logger.debug('VectHare: fallback apply failed', e);
                        }
                    }
                }
            }

            if (applied) {
                toastr.success('Semantic WI entry applied (best-effort)');
                return;
            }

            // Final fallback: copy content to clipboard and instruct user
            const text = first.content || (Array.isArray(first.key) ? first.key.join(', ') : String(first.key));
            try {
                await navigator.clipboard.writeText(text);
                toastr.info('Semantic entry copied to clipboard. Paste into World Info editor to activate.');
            } catch (e) {
                logger.debug('VectHare: Clipboard write failed, showing content in console');
                logger.debug('Semantic entry content:', text);
                toastr.info('Semantic entry logged to console. Paste into World Info editor to activate.');
            }

        } catch (e) {
            console.error('VectHare: Apply semantic WI failed', e);
            toastr.error('Failed to apply semantic WI entry: ' + e.message);
        }
    });

    // Injection position (where chunks appear in prompt)
    $('#vecthare_injection_position')
        .val(settings.position ?? 0)
        .on('change', function() {
            const value = parseInt($(this).val());
            settings.position = value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
            // Show/hide depth slider based on position
            $('#vecthare_injection_depth_row').toggle(value === 1);
        });
    // Initialize depth row visibility
    $('#vecthare_injection_depth_row').toggle((settings.position ?? 0) === 1);

    // Injection depth (for in-chat position)
    $('#vecthare_injection_depth')
        .val(settings.depth ?? 2)
        .on('input', function() {
            const value = parseInt($(this).val());
            const safeValue = isNaN(value) ? 2 : value;
            $('#vecthare_injection_depth_value').text(safeValue);
            settings.depth = safeValue;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_injection_depth_value').text(settings.depth ?? 2);

    // RAG Context settings
    $('#vecthare_rag_context')
        .val(settings.rag_context || '')
        .on('input', function() {
            settings.rag_context = $(this).val();
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_rag_xml_tag')
        .val(settings.rag_xml_tag || '')
        .on('input', function() {
            // Sanitize: only allow alphanumeric, underscore, hyphen
            const sanitized = $(this).val().replace(/[^a-zA-Z0-9_-]/g, '');
            $(this).val(sanitized);
            settings.rag_xml_tag = sanitized;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Global temporal weighting defaults
    const updateDecayTypeSection = (enabled) => {
        const $section = $('#vecthare_default_decay_type_section');
        const $radios = $section.find('input[type="radio"]');

        if (enabled) {
            $section.removeClass('vecthare-subsection-disabled');
            $radios.prop('disabled', false);
            // Select the saved type (or default to 'decay') when enabling
            const savedType = settings.default_decay_type || 'decay';
            $(`input[name="vecthare_default_decay_type"][value="${savedType}"]`).prop('checked', true);
        } else {
            $section.addClass('vecthare-subsection-disabled');
            $radios.prop('disabled', true).prop('checked', false);
        }
    };

    $('#vecthare_default_decay_enabled')
        .prop('checked', settings.default_decay_enabled || false)
        .on('change', function() {
            const enabled = $(this).prop('checked');
            settings.default_decay_enabled = enabled;
            updateDecayTypeSection(enabled);
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Initialize the section state
    updateDecayTypeSection(settings.default_decay_enabled || false);

    $('input[name="vecthare_default_decay_type"]').on('change', function() {
        settings.default_decay_type = $(this).val();
        applySettingsSnapshot(settings);
        saveSettingsDebounced();
    });

    // Provider-specific settings

    // ElectronHub model
    $('#vecthare_electronhub_model')
        .val(settings.electronhub_model)
        .on('change', function() {
            settings.electronhub_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Alternative endpoint
    bindAlternativeEndpointControls(document.getElementById('vecthare_settings'), settings, () => {
        applySettingsSnapshot(settings);
        saveSettingsDebounced();
    });

    // WebLLM model
    $('#vecthare_webllm_model')
        .val(settings.webllm_model)
        .on('change', function() {
            settings.webllm_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // WebLLM Load Model button
    $('#vecthare_webllm_load').on('click', async function() {
        const modelId = settings.webllm_model;

        if (!modelId) {
            toastr.warning('Please select a WebLLM model first', 'No Model Selected');
            return;
        }

        if (!isWebLlmSupported()) {
            return; // isWebLlmSupported already shows appropriate error
        }

        const $button = $(this);
        const originalHtml = $button.html();
        $button.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i> Loading...');

        await executeWithWebLlmErrorHandling(async () => {
            const provider = getWebLlmProvider();
            await provider.loadModel(modelId);
            toastr.success(`WebLLM model "${modelId}" loaded successfully`, 'Model Loaded');
        });

        $button.prop('disabled', false).html(originalHtml);
    });

    // WebLLM Install Extension button
    $('#vecthare_webllm_install').on('click', function(e) {
        e.preventDefault();
        e.stopPropagation();

        if (Object.hasOwn(SillyTavern, 'llm')) {
            toastr.info('WebLLM extension is already installed. Try refreshing the page.', 'Already Installed');
            return;
        }

        openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-WebLLM');
    });

    // Ollama model
    $('#vecthare_ollama_model')
        .val(settings.ollama_model)
        .on('input', function() {
            settings.ollama_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_ollama_keep')
        .prop('checked', settings.ollama_keep)
        .on('input', function() {
            settings.ollama_keep = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // BananaBread reranking
    $('#vecthare_bananabread_rerank')
        .prop('checked', settings.bananabread_rerank)
        .on('input', function() {
            settings.bananabread_rerank = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // BananaBread API key
    // Note: We store in extension settings because custom keys aren't returned by ST's readSecretState()
    const updateBananaBreadKeyDisplay = () => {
        const savedKey = settings.bananabread_api_key;
        if (savedKey) {
            // Mask the key for display (show last 4 chars)
            const masked = savedKey.length > 4
                ? '*'.repeat(Math.min(savedKey.length - 4, 8)) + savedKey.slice(-4)
                : '*'.repeat(savedKey.length);
            $('#vecthare_bananabread_apikey').attr('placeholder', `Key saved: ${masked}`);
        } else {
            $('#vecthare_bananabread_apikey').attr('placeholder', 'Paste key here to save...');
        }
    };
    updateBananaBreadKeyDisplay();

    $('#vecthare_bananabread_apikey')
        .on('change', async function() {
            const value = String($(this).val()).trim();
            if (value) {
                // Store in extension settings (primary storage for this key)
                settings.bananabread_api_key = value;
                applySettingsSnapshot(settings);
                saveSettingsDebounced();

                // Also write to ST secrets for potential future compatibility
                await writeSecret('bananabread_api_key', value);

                toastr.success('BananaBread API key saved');
                $(this).val('');
                updateBananaBreadKeyDisplay();
            }
        });

    // OpenAI model
    $('#vecthare_openai_model')
        .val(settings.openai_model)
        .on('change', function() {
            settings.openai_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Cohere model
    $('#vecthare_cohere_model')
        .val(settings.cohere_model)
        .on('change', function() {
            settings.cohere_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // TogetherAI model
    $('#vecthare_togetherai_model')
        .val(settings.togetherai_model)
        .on('change', function() {
            settings.togetherai_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // vLLM model
    $('#vecthare_vllm_model')
        .val(settings.vllm_model)
        .on('input', function() {
            settings.vllm_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Google model
    $('#vecthare_google_model')
        .val(settings.google_model)
        .on('change', function() {
            settings.google_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // OpenRouter model
    $('#vecthare_openrouter_model')
        .val(settings.openrouter_model)
        .on('input', function() {
            settings.openrouter_model = String($(this).val());
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // OpenRouter API key - saves directly to ST secrets
    // Show existing key if set
    const updateOpenRouterKeyDisplay = () => {
        const secrets = secret_state[SECRET_KEYS.OPENROUTER];
        if (Array.isArray(secrets) && secrets.length > 0) {
            const activeSecret = secrets.find(s => s.active) || secrets[0];
            if (activeSecret?.value) {
                $('#vecthare_openrouter_apikey').attr('placeholder', activeSecret.value);
            }
        }
    };
    updateOpenRouterKeyDisplay();

    $('#vecthare_openrouter_apikey')
        .on('change', async function() {
            const value = String($(this).val()).trim();
            if (value) {
                await writeSecret(SECRET_KEYS.OPENROUTER, value);
                await readSecretState(); // Refresh state to get masked value
                toastr.success('OpenRouter API key saved');
                $(this).val(''); // Clear input
                updateOpenRouterKeyDisplay(); // Show masked key in placeholder
            }
        });

    // Rate Limiting
    $('#vecthare_rate_limit_calls')
        .val(settings.rate_limit_calls || 0)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.rate_limit_calls = isNaN(value) ? 0 : value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_rate_limit_interval')
        .val(settings.rate_limit_interval || 60)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.rate_limit_interval = isNaN(value) ? 60 : value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // VEC-6: Insert Batch Size
    $('#vecthare_insert_batch_size')
        .val(settings.insert_batch_size || 50)
        .on('input', function() {
            const value = parseInt($(this).val());
            $('#vecthare_insert_batch_size_value').text(value);
            settings.insert_batch_size = value;
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });
    $('#vecthare_insert_batch_size_value').text(settings.insert_batch_size || 50);

    // Minimum chat length before injection starts
    $('#vecthare_min_chat_length')
        .val(settings.min_chat_length ?? 0)
        .on('input', function() {
            const value = parseInt($(this).val());
            settings.min_chat_length = isNaN(value) ? 0 : Math.max(0, value);
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    // Action buttons
    $('#vecthare_vectorize_content').on('click', () => {
        openContentVectorizer();
    });
    $('#vecthare_vectorize_all').on('click', callbacks.onVectorizeAll);
    $('#vecthare_purge').on('click', callbacks.onPurge);
    $('#vecthare_run_diagnostics').on('click', callbacks.onRunDiagnostics);
    $('#vecthare_include_production_tests')
        .prop('checked', settings.include_production_tests || false)
        .on('change', function() {
            settings.include_production_tests = $(this).prop('checked');
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_log_level')
        .val(settings.log_level || 'info')
        .on('change', function() {
            settings.log_level = String($(this).val());
            configureLogger({ level: settings.log_level });
            applySettingsSnapshot(settings);
            saveSettingsDebounced();
        });

    $('#vecthare_database_browser').on('click', () => {
        openDatabaseBrowser();
    });
    $('#vecthare_view_results').on('click', () => {
        openSearchDebugModal();
    });
    $('#vecthare_text_cleaning').on('click', () => {
        openTextCleaningManager();
    });

    // Initialize provider-specific settings visibility
    toggleProviderSettings(settings.source, settings);

    // =========================================================================
    // COTTON-TALES EMOTION CLASSIFIER INTEGRATION
    // =========================================================================
    initializeCottonTalesIntegration(settings);
}

