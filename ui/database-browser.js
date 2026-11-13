import { openEmbeddingMigrationDialog } from './embedding-migration-dialog.js';
import { openCollectionDuplicateDialog } from './collection-duplicate-dialog.js';
/**
 * ============================================================================
 * VECTHARE DATABASE BROWSER
 * ============================================================================
 * Comprehensive vector database browser UI
 * Main entry point for browsing, managing, and editing all vector collections
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import {
    loadAllCollections,
    setCollectionEnabled,
    clearCollectionRegistry,
    deleteCollection,
} from "../core/collection-loader.js";
import {
    cleanupOrphanedMeta,
    getCollectionMeta,
    getCollectionActivationSummary,
    getCollectionDecaySummary,
    getCollectionLockCount,
    getCollectionCharacterLockCount,
} from "../core/collection-metadata.js";
import { icons } from "./icons.js";
import { openVisualizer } from "./chunk-visualizer.js";
import {
  exportCollection,
  importCollection,
  downloadExport,
  readImportFile,
  validateImportData,
  getExportInfo,
} from "../core/collection-export.js";
import {
    embedDataInPNG,
    extractDataFromPNG,
    downloadPNG,
    readPNGFile,
    convertToPNG,
} from "../core/png-export.js";
import { escapeHtml } from "../utils/html.js";
import { pluginRequest } from '../backends/similharity-backend.js';
import { logger } from '../utils/logger.js';
import { browserState } from "./database-browser-state.js";
import { openActivationEditor } from "./collection-activation-editor.js";
import { openRenameDialog, openModelSwitcher } from "./collection-dialogs.js";
import { bindSearchEvents, resetSearchEventsBound } from "./database-browser-search.js";
import { renderBulkList, bindBulkEvents, resetBulkEventsBound } from "./database-browser-bulk.js";

// Plugin availability cache
let pluginAvailable = null;

/**
 * Check if the Similharity plugin is available
 * @returns {Promise<boolean>}
 */
async function checkPluginAvailable() {
  if (pluginAvailable !== null) return pluginAvailable;

  try {
    const response = await pluginRequest('/health');
    pluginAvailable = response.ok;
  } catch {
    pluginAvailable = false;
  }
  return pluginAvailable;
}

/**
 * Initializes the database browser
 * @param {object} settings VectHare settings
 */
export function initializeDatabaseBrowser(settings) {
  browserState.settings = settings;
  logger.debug("VectHare Database Browser: Initialized");
}

/**
 * Opens the database browser modal
 */
export async function openDatabaseBrowser() {
  if (browserState.isOpen) {
    logger.debug("VectHare Database Browser: Already open");
    return;
  }

  browserState.isOpen = true;

  // Check plugin availability
  browserState.pluginAvailable = await checkPluginAvailable();

  // Create modal if it doesn't exist
  if ($("#vecthare_database_browser_modal").length === 0) {
    createBrowserModal();
  }

  // Show/hide plugin warning banner
  updatePluginWarningBanner();

  // Load collections
  await refreshCollections();

  // Show modal
  $("#vecthare_database_browser_modal").fadeIn(200);
  logger.debug("VectHare Database Browser: Opened");
}

/**
 * Updates the plugin warning banner visibility
 */
function updatePluginWarningBanner() {
  const banner = $("#vecthare_plugin_warning_banner");
  if (browserState.pluginAvailable) {
    banner.hide();
  } else {
    banner.show();
  }
}

/**
 * Closes the database browser modal
 */
export function closeDatabaseBrowser() {
  $("#vecthare_database_browser_modal").fadeOut(200);
  browserState.isOpen = false;
  // Reset event bound flags for clean rebind on next open
  resetEventFlags();
  logger.debug("VectHare Database Browser: Closed");
}

/**
 * Resets event bound flags (called on modal close)
 */
function resetEventFlags() {
  // Reset flags so events rebind properly on next modal open
  resetBulkEventsBound();
  resetSearchEventsBound();
}

/**
 * Creates the browser modal HTML structure
 */
function createBrowserModal() {
  const modalHtml = `
        <div id="vecthare_database_browser_modal" class="vecthare-modal">
            <div class="vecthare-modal-content vecthare-database-browser-content">
                <!-- Header -->
                <div class="vecthare-modal-header">
                    <h3>🗃️ VectHare Database Browser</h3>
                    <button class="vecthare-btn-icon" id="vecthare_browser_close">✕</button>
                </div>

                <!-- Plugin Warning Banner (hidden by default, shown when plugin unavailable) -->
                <div id="vecthare_plugin_warning_banner" class="vecthare-warning-banner" style="display: none;">
                    <i class="fa-solid fa-triangle-exclamation" style="color: var(--SmartThemeQuoteColor);"></i>
                    <div class="vecthare-warning-text">
                        <strong>Limited Discovery Mode</strong>
                        <span>Similharity plugin not detected. Only registered collections and current chat can be discovered.
                        Collections created outside VectHare won't appear here.
                        <a href="https://github.com/Coneja-Chibi/VectHare/tree/Similharity-Plugin" target="_blank">Install the plugin</a> for full filesystem scanning.</span>
                    </div>
                </div>

                <!-- Browser Tabs -->
                <div class="vecthare-browser-tabs">
                    <button class="vecthare-tab-btn active" data-tab="collections">
                        ${icons.folder(16)} Collections
                    </button>
                    <button class="vecthare-tab-btn" data-tab="search">
                        ${icons.search(16)} Search
                    </button>
                    <button class="vecthare-tab-btn" data-tab="bulk">
                        ${icons.listChecks(16)} Bulk Operations
                    </button>
                </div>

                <!-- Tab Content -->
                <div class="vecthare-browser-content">
                    <!-- Collections Tab -->
                    <div id="vecthare_tab_collections" class="vecthare-tab-content active">
                        <!-- Scope Filters (V1-style) -->
                        <div class="vecthare-scope-filters">
                            <button class="vecthare-scope-filter active" data-scope="all" title="Show all collections">All</button>
                            <button class="vecthare-scope-filter" data-scope="global" title="Global = collections set to 'Always Active'">Global</button>
                            <button class="vecthare-scope-filter" data-scope="character" title="Character = collections locked to at least one character">Character</button>
                            <button class="vecthare-scope-filter" data-scope="chat" title="Chat = collections locked to at least one chat">Chat</button>

                            <!-- Small badge and hint describing current scope filter -->
                        </div>

                        <!-- Type Filters -->
                        <div class="vecthare-type-filters">
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="all" checked>
                                All Types
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="chat">
                                ${icons.messageSquare(14)} Chats
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="lorebook">
                                ${icons.bookOpen(14)} Lorebooks
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="character">
                                ${icons.user(14)} Characters
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="document">
                                ${icons.fileText(14)} Documents
                            </label>
                            <label>
                                <input type="radio" name="vecthare_type_filter" value="web">
                                ${icons.globe(14)} Web
                            </label>
                        </div>

                        <!-- Search Box -->
                        <div class="vecthare-search-box">
                            <input type="text"
                                   id="vecthare_collection_search"
                                   placeholder="Search collections..."
                                   autocomplete="off">
                        </div>

                        <!-- Collections List -->
                        <div id="vecthare_collections_list" class="vecthare-collections-list">
                            <div class="vecthare-loading">Loading collections...</div>
                        </div>

                        <!-- Stats Footer -->
                        <div class="vecthare-browser-stats">
                            <span id="vecthare_browser_stats_text">No collections</span>
                            <div class="vecthare-browser-actions">
                                <button id="vecthare_import_collection" class="vecthare-btn-sm" title="Import collection from file">
                                    📥 Import
                                </button>
                                <button id="vecthare_reset_registry" class="vecthare-reset-btn" title="Clear registry and rescan from disk">
                                    <i class="fa-solid fa-arrows-rotate"></i> Resync
                                </button>
                            </div>
                        </div>
                        <!-- Hidden file inputs for import -->
                        <input type="file" id="vecthare_import_file" accept=".json,.vecthare.json,.png,image/png" style="display: none;">
                        <input type="file" id="vecthare_png_image_picker" accept="image/*" style="display: none;">
                    </div>

                    <!-- Search Tab -->
                    <div id="vecthare_tab_search" class="vecthare-tab-content">
                        <div class="vecthare-search-panel">
                            <!-- Search Input -->
                            <div class="vecthare-search-input-row">
                                <input type="text"
                                       id="vecthare_semantic_search"
                                       class="vecthare-search-input"
                                       placeholder="Search across all collections..."
                                       autocomplete="off">
                                <button id="vecthare_search_btn" class="vecthare-btn vecthare-btn-primary">
                                    ${icons.search(16)} Search
                                </button>
                            </div>

                            <!-- Search Options -->
                            <div class="vecthare-search-options">
                                <div class="vecthare-search-option">
                                    <label>Results per collection:</label>
                                    <input type="number" id="vecthare_search_topk" value="5" min="1" max="50">
                                </div>
                                <div class="vecthare-search-option">
                                    <label>Min score:</label>
                                    <input type="number" id="vecthare_search_threshold" value="0.3" min="0" max="1" step="0.05">
                                </div>
                                <div class="vecthare-search-option">
                                    <label>
                                        <input type="checkbox" id="vecthare_search_enabled_only" checked>
                                        Enabled collections only
                                    </label>
                                </div>
                            </div>

                            <!-- Keyword Filter -->
                            <div class="vecthare-keyword-filter-section">
                                <div class="vecthare-keyword-filter-header">
                                    ${icons.filter(16)} <span>Keyword Filter</span>
                                    <button id="vecthare_scan_keywords" class="vecthare-btn-sm" title="Scan all collections for keywords">
                                        <i class="fa-solid fa-sync"></i> Scan
                                    </button>
                                </div>
                                <div class="vecthare-keyword-filter-input-row">
                                    <input type="text"
                                           id="vecthare_keyword_filter"
                                           class="vecthare-keyword-filter-input"
                                           placeholder="Filter by keywords (comma-separated)..."
                                           autocomplete="off">
                                    <button id="vecthare_clear_keyword_filter" class="vecthare-btn-sm" title="Clear filter">
                                        ${icons.x(14)}
                                    </button>
                                </div>
                                <div id="vecthare_keyword_tags" class="vecthare-keyword-tags">
                                    <span class="vecthare-keyword-hint">Click "Scan" to discover keywords in your collections</span>
                                </div>
                            </div>

                            <!-- Search Results -->
                            <div id="vecthare_search_results" class="vecthare-search-results">
                                <div class="vecthare-search-empty">
                                    ${icons.search(48)}
                                    <p>Enter a query to search across all collections</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Bulk Operations Tab -->
                    <div id="vecthare_tab_bulk" class="vecthare-tab-content">
                        <div class="vecthare-bulk-panel">
                            <!-- Selection Info -->
                            <div class="vecthare-bulk-header">
                                <div class="vecthare-bulk-select-all">
                                    <label>
                                        <input type="checkbox" id="vecthare_bulk_select_all">
                                        Select All Visible
                                    </label>
                                    <span id="vecthare_bulk_count">0 selected</span>
                                </div>
                                <div class="vecthare-bulk-filter">
                                    <select id="vecthare_bulk_filter">
                                        <option value="all">All Collections</option>
                                        <option value="enabled">Enabled Only</option>
                                        <option value="disabled">Disabled Only</option>
                                    </select>
                                </div>
                            </div>

                            <!-- Bulk Actions -->
                            <div class="vecthare-bulk-actions">
                                <button id="vecthare_bulk_enable" class="vecthare-btn vecthare-btn-sm" disabled>
                                    ${icons.toggleRight(16)} Enable Selected
                                </button>
                                <button id="vecthare_bulk_disable" class="vecthare-btn vecthare-btn-sm" disabled>
                                    ${icons.toggleLeft(16)} Disable Selected
                                </button>
                                <button id="vecthare_bulk_export" class="vecthare-btn vecthare-btn-sm" disabled>
                                    ${icons.download(16)} Export Selected
                                </button>
                                <button id="vecthare_bulk_delete" class="vecthare-btn vecthare-btn-sm vecthare-btn-danger" disabled>
                                    ${icons.trash(16)} Delete Selected
                                </button>
                            </div>

                            <!-- Collection List with Checkboxes -->
                            <div id="vecthare_bulk_list" class="vecthare-bulk-list">
                                <div class="vecthare-loading">Loading collections...</div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;

  $("body").append(modalHtml);

  // Bind events
  bindBrowserEvents();
}

/**
 * Binds event handlers for browser UI
 */
function bindBrowserEvents() {
  // Close button
  $("#vecthare_browser_close").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    closeDatabaseBrowser();
  });

  // Stop propagation on mousedown (ST listens on mousedown to close drawers)
  // This prevents the drawer from closing when clicking inside the modal
  $("#vecthare_database_browser_modal").on("mousedown touchstart", function (e) {
    e.stopPropagation();
  });

  // Close when clicking directly on the modal background (overlay)
  $("#vecthare_database_browser_modal").on("click", function (e) {
    if (e.target === this) {
      e.preventDefault();
      closeDatabaseBrowser();
    }
  });

  // Tab switching
  $(".vecthare-tab-btn").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    const tab = $(this).data("tab");
    switchTab(tab);
  });

  // Scope filters
  $(".vecthare-scope-filter").on("click", function (e) {
    e.stopPropagation();
    e.preventDefault();
    $(".vecthare-scope-filter").removeClass("active");
    $(this).addClass("active");
    browserState.filters.scope = $(this).data("scope");
    renderCollections();
  });

  // Type filters
  $('input[name="vecthare_type_filter"]').on("change", function (e) {
    e.stopPropagation();
    browserState.filters.collectionType = $(this).val();
    renderCollections();
  });

  // Search input
  $("#vecthare_collection_search").on("input", function (e) {
    e.stopPropagation();
    browserState.filters.searchQuery = $(this).val().toLowerCase();
    renderCollections();
  });

  // Resync button - clears registry and rescans from disk
  $("#vecthare_reset_registry").on("click", async function (e) {
    e.stopPropagation();
    e.preventDefault();

    const confirmed = confirm(
      "This will clear the collection registry and rescan from disk.\n\n" +
        "Any ghost entries (collections that no longer exist on disk) will be removed.\n\n" +
        "Continue?",
    );

    if (!confirmed) return;

    try {
      // Clear the registry
      clearCollectionRegistry();

      // Refresh collections (will rediscover from disk)
      await refreshCollections();

      toastr.success("Registry cleared and resynced from disk", "VectHare");
    } catch (error) {
      console.error("VectHare: Failed to resync", error);
      toastr.error(`Failed to resync: ${error.message}`, "VectHare");
    }
  });

  // Keyboard shortcuts
  $(document).on("keydown.vecthare_browser", function (e) {
    if (!browserState.isOpen) return;

    if (e.key === "Escape") {
      closeDatabaseBrowser();
    }
  });

  // Import button
  $("#vecthare_import_collection").on("click", function (e) {
    e.stopPropagation();
    $("#vecthare_import_file").click();
  });

  // Import file handler (supports JSON and PNG)
  $("#vecthare_import_file").on("change", async function (e) {
    const file = e.target.files[0];
    if (!file) return;

    // Reset input so same file can be selected again
    $(this).val("");

    try {
      toastr.info("Reading import file...", "VectHare");

      let data;

      // Check if it's a PNG file
      if (
        file.type === "image/png" ||
        file.name.toLowerCase().endsWith(".png")
      ) {
        const pngData = await readPNGFile(file);
        data = await extractDataFromPNG(pngData);

        if (!data) {
          toastr.error(
            "This PNG does not contain VectHare data.",
            "VectHare Import",
          );
          return;
        }

        toastr.info("Found VectHare data in PNG!", "VectHare");
      } else {
        // JSON file
        data = await readImportFile(file);
      }

      const info = getExportInfo(data);
      const validation = validateImportData(data, browserState.settings);

      const targetId = `vecthare_import_${crypto.randomUUID().replaceAll("-", "")}`;
      // Imports create a separate disabled copy; an existing index is never purged.
      let message = `Import "${info.collections[0]?.name || "collection"}"?\n\n`;
      message += `• ${info.totalChunks} chunks\n`;
      message += `• ${info.totalChunksWithVectors} with vectors\n`;
      message += `\nNew destination: ${targetId}. The original is retained. The copy stays disabled until you review and enable it.\n`;

      if (info.embedding) {
        message += `\nEmbedding: ${info.embedding.source}/${info.embedding.model || "default"}\n`;
        message += `Dimension: ${info.embedding.dimension || "unknown"}\n`;
      }

      if (validation.warnings.length > 0) {
        message += `\n⚠️ Warnings:\n`;
        validation.warnings.forEach((w) => {
          message += `• ${w}\n`;
        });
      }

      if (!validation.compatible && info.totalChunksWithVectors > 0) {
        message += `\nSaved vector compatibility is ${validation.compatibilityStatus}. Matching provider/model names alone are insufficient.\n`;
        message += `This copy will be re-embedded with the selected provider (${browserState.settings.source}).`;

      }

      if (!validation.valid) {
        toastr.error(
          `Invalid export file:\n${validation.errors.join("\n")}`,
          "VectHare Import",
        );
        return;
      }

      const confirmed = confirm(message);
      if (!confirmed) return;

      // Perform import
      const result = await importCollection(data, browserState.settings, {
        collectionId: targetId,
        overwrite: false,
      });

      if (result.success) {
        const vectorMsg = result.usedVectors
          ? "(used existing vectors)"
          : "(re-embedded)";
        toastr.success(
          `Verified ${result.chunkCount} chunks ${vectorMsg} in ${result.collectionId}. The copy is disabled; review and enable it in the browser.`,
          "VectHare Import",
        );

        // Refresh collections list
        await refreshCollections();
      }
    } catch (error) {
      console.error("VectHare: Import failed", error);
      toastr.error(`Import failed: ${error.message}`, "VectHare");
    }
  });
}

/**
 * Switches active tab
 * @param {string} tabName Tab identifier
 */
function switchTab(tabName) {
  $(".vecthare-tab-btn").removeClass("active");
  $(`.vecthare-tab-btn[data-tab="${tabName}"]`).addClass("active");

  $(".vecthare-tab-content").removeClass("active");
  $(`#vecthare_tab_${tabName}`).addClass("active");

  // Initialize tab-specific content
  if (tabName === "bulk") {
    renderBulkList();
    bindBulkEvents();
  } else if (tabName === "search") {
    bindSearchEvents();
  }
}

/**
 * Refreshes collections from storage
 */
export async function refreshCollections() {
  try {
    browserState.collections = await loadAllCollections(browserState.settings);

    // Clean up orphaned metadata entries (collections that no longer exist)
    const actualIds = browserState.collections.map((c) => c.id);
    const cleanupResult = cleanupOrphanedMeta(actualIds);
    if (cleanupResult.removed > 0) {
      logger.debug(
        `VectHare: Cleaned up ${cleanupResult.removed} orphaned metadata entries`,
      );
    }

    renderCollections();
  } catch (error) {
    console.error("VectHare: Failed to load collections", error);
    $("#vecthare_collections_list").html(`
            <div class="vecthare-error">
                Failed to load collections. Check console for details.
            </div>
        `);
  }
}

/**
 * Renders collections list based on current filters
 */
export function renderCollections() {
  const container = $("#vecthare_collections_list");

    // Apply filters
    let filtered = browserState.collections.filter(c => {
        const scopeFilter = browserState.filters.scope;

        // Scope filter:
        // - 'all' => no filter
        // - 'global' => show collections explicitly set to alwaysActive
        // - 'chat' => show collections locked to at least one chat
        // - 'character' => show collections locked to at least one character
        // - otherwise: preserve legacy behavior (compare c.scope)
        if (scopeFilter !== 'all') {
            if (scopeFilter === 'global') {
                const meta = getCollectionMeta(c.id);
                if (!meta || meta.alwaysActive !== true) return false;
            } else if (scopeFilter === 'chat') {
                if (getCollectionLockCount(c.id) <= 0) return false;
            } else if (scopeFilter === 'character') {
                if (getCollectionCharacterLockCount(c.id) <= 0) return false;
            } else {
                if (c.scope !== scopeFilter) return false;
            }
        }

    // Type filter - map filter categories to actual collection types
    if (browserState.filters.collectionType !== "all") {
      const typeMap = {
        chat: ["chat"],
        lorebook: ["lorebook"],
        character: ["character", "persona"],
        document: ["file", "doc", "paste", "select", "current"],
        web: ["url", "wiki", "youtube"],
      };
      const allowedTypes = typeMap[browserState.filters.collectionType];
      if (allowedTypes && !allowedTypes.includes(c.type)) {
        return false;
      }
    }

    // Search filter
    if (browserState.filters.searchQuery) {
      const searchLower = browserState.filters.searchQuery;
      return (
        c.name.toLowerCase().includes(searchLower) ||
        c.id.toLowerCase().includes(searchLower)
      );
    }

    return true;
  });

  if (filtered.length === 0) {
    container.html(`
            <div class="vecthare-empty-state">
                <p>No collections found.</p>
                <small>Vectorize some chat messages to create collections!</small>
            </div>
        `);
    updateStats(0, 0);
    return;
  }

  // Render collection cards
  const cardsHtml = filtered.map((c) => renderCollectionCard(c)).join("");
  container.html(cardsHtml);

  // Bind card events
  bindCollectionCardEvents();

  // Update stats
  const totalChunks = filtered.reduce((sum, c) => sum + c.chunkCount, 0);
  updateStats(filtered.length, totalChunks);
}

/**
 * Renders a single collection card (V1-inspired layout)
 * @param {object} collection Collection data
 * @returns {string} Card HTML
 */
function renderCollectionCard(collection) {
  // Map collection types to icon functions
  const typeIconMap = {
    chat: icons.messageSquare,
    file: icons.fileText,
    doc: icons.fileText,
    paste: icons.fileText,
    select: icons.fileText,
    current: icons.fileText,
    lorebook: icons.bookOpen,
    character: icons.user,
    persona: icons.user,
    url: icons.globe,
    wiki: icons.globe,
    youtube: icons.globe,
  };
  const iconFn = typeIconMap[collection.type] || icons.box;
  const typeIcon = iconFn(14, "vecthare-type-icon");

  const scopeBadge =
    {
      global:
        '<span class="vecthare-badge vecthare-badge-global">Global</span>',
      character:
        '<span class="vecthare-badge vecthare-badge-character">Character</span>',
      chat: '<span class="vecthare-badge vecthare-badge-chat">Chat</span>',
    }[collection.scope] || "";

  const statusBadge = collection.enabled
    ? '<span class="vecthare-badge vecthare-badge-success">Active</span>'
    : '<span class="vecthare-badge vecthare-badge-muted">Paused</span>';

  // Activation badge (shows triggers or conditions)
  const activationSummary = getCollectionActivationSummary(collection.id);
  // Backend badge - shows vector database (Standard, LanceDB, Qdrant)
  const backendDisplayName =
    {
      standard: "Standard",
      lancedb: "LanceDB",
      qdrant: "Qdrant",
    }[collection.backend] || collection.backend;

  const backendBadge = collection.backend
    ? `<span class="vecthare-badge vecthare-badge-backend" title="Vector backend">${backendDisplayName}</span>`
    : "";

  // Source badge - shows embedding source (transformers, palm, openai, etc.)
  const sourceBadge =
    collection.source && collection.source !== "unknown"
      ? `<span class="vecthare-badge vecthare-badge-source" title="Embedding source">${collection.source}</span>`
      : "";

  // Model info - show current model and count if multiple
  const hasMultipleModels = collection.models && collection.models.length > 1;
  const currentModelName = collection.model || "(default)";
  const modelBadge = hasMultipleModels
    ? `<span class="vecthare-badge vecthare-badge-model" title="Current model: ${currentModelName} (${collection.models.length} available)">📐 ${currentModelName}</span>`
    : "";

  // Temporal decay badge
  const decaySummary = getCollectionDecaySummary(collection.id);
  let decayBadge = "";
  if (decaySummary.enabled) {
    const decayIcon = decaySummary.isCustom ? "⏳" : "⏱️";
    const decayTitle = decaySummary.isCustom
      ? `Custom decay: ${decaySummary.description}`
      : `Default decay: ${decaySummary.description}`;
    decayBadge = `<span class="vecthare-badge vecthare-badge-decay ${decaySummary.isCustom ? "vecthare-badge-decay-custom" : ""}" title="${decayTitle}">${decayIcon}</span>`;
  }

  // Lock badge - shows if collection is locked and to how many chats
  const lockCount = getCollectionLockCount(collection.id);
  let lockBadge = "";
  if (lockCount > 0) {
    const lockTitle = `Locked to ${lockCount} chat${lockCount !== 1 ? "s" : ""}`;
    lockBadge = `<span class="vecthare-badge vecthare-badge-lock" title="${lockTitle}">🔒 ${lockCount}</span>`;
  }

  // Use registryKey for unique identification (source:id format)
  const uniqueKey = collection.registryKey || collection.id;

  return `
        <div class="vecthare-collection-card" data-collection-key="${uniqueKey}" data-status="${collection.enabled ? "active" : "paused"}">
            <div class="vecthare-collection-header">
                <span class="vecthare-collection-title">
                    ${typeIcon} ${escapeHtml(collection.name)}
                </span>
                <div class="vecthare-collection-badges">
                    ${scopeBadge}
                    ${backendBadge}
                    ${sourceBadge}
                    ${modelBadge}
                    ${decayBadge}
                    ${lockBadge}
                    ${statusBadge}
                </div>
            </div>

            <div class="vecthare-collection-meta">
                <span>${collection.chunkCount} chunks</span>
                <span>ID: ${collection.id}</span>
            </div>

            <div class="vecthare-collection-actions">
                <button class="vecthare-btn-sm vecthare-action-toggle"
                        data-collection-key="${uniqueKey}"
                        data-enabled="${collection.enabled}">
                    ${collection.enabled ? icons.pause(16) + " Pause" : icons.play(16) + " Enable"}
                </button>
                <button class="vecthare-btn-sm vecthare-action-rename"
                        data-collection-key="${uniqueKey}"
                        data-current-name="${escapeHtml(collection.name)}"
                        title="Rename this collection">
                    ${icons.pencil(16)} Rename
                </button>
                <button class="vecthare-btn-sm vecthare-action-activation ${activationSummary.mode !== "auto" || decaySummary.isCustom ? "vecthare-has-settings" : ""}"
                        data-collection-key="${uniqueKey}"
                        title="Configure activation, triggers, conditions, and temporal decay">
                    ${icons.settings(16)} Settings
                </button>
                ${
                  hasMultipleModels && !getCollectionMeta(collection.registryKey).embeddingConnection
                    ? `
                <button class="vecthare-btn-sm vecthare-action-switch-model"
                        data-collection-key="${uniqueKey}"
                        title="Switch embedding model (${collection.models.length} available)">
                    <i class="fa-solid fa-code-branch"></i> Model
                </button>
                `
                    : ""
                }
                <button class="vecthare-btn-sm vecthare-action-embedding" data-collection-key="${uniqueKey}">Embedding Provider / Migrate</button>
                <button class="vecthare-btn-sm vecthare-action-duplicate" data-collection-key="${uniqueKey}"
                        title="Copy stored vectors and independent settings to another collection or storage backend">Duplicate collection</button>
                <button class="vecthare-btn-sm vecthare-action-open-folder"
                        data-collection-key="${uniqueKey}"
                        data-backend="${collection.backend}"
                        data-source="${collection.source || "transformers"}"
                        title="Open in file explorer">
                    ${icons.folderOpen(16)} Open Folder
                </button>
                <button class="vecthare-btn-sm vecthare-action-visualize"
                        data-collection-key="${uniqueKey}"
                        data-backend="${collection.backend}"
                        data-source="${collection.source || "transformers"}"
                        title="View and edit chunks in this collection">
                    ${icons.eye(16)} View Chunks
                </button>
                <div class="vecthare-export-dropdown">
                    <button class="vecthare-btn-sm vecthare-btn-export vecthare-action-export-toggle"
                            title="Export collection">
                        ${icons.download(16)} Export
                    </button>
                    <div class="vecthare-export-options">
                        <button class="vecthare-btn-sm vecthare-btn-json vecthare-action-export"
                                data-collection-key="${uniqueKey}"
                                data-collection-id="${collection.id}"
                                data-backend="${collection.backend}"
                                data-source="${collection.source || "transformers"}"
                                data-model="${collection.model || ""}"
                                title="Export as JSON (includes vectors)">
                            ${icons.fileExport(16)} JSON
                        </button>
                        <button class="vecthare-btn-sm vecthare-btn-png vecthare-action-export-png"
                                data-collection-key="${uniqueKey}"
                                data-collection-id="${collection.id}"
                                data-backend="${collection.backend}"
                                data-source="${collection.source || "transformers"}"
                                data-model="${collection.model || ""}"
                                title="Export as PNG (shareable image)">
                            ${icons.image(16)} PNG
                        </button>
                    </div>
                </div>
                <button class="vecthare-btn-sm vecthare-btn-danger vecthare-action-delete"
                        data-collection-key="${uniqueKey}">
                    ${icons.trash(16)} Delete
                </button>
            </div>
        </div>
    `;
}

/**
 * Helper to find collection by its unique key (registryKey or id)
 */
export function findCollectionByKey(key) {
  return browserState.collections.find((c) => (c.registryKey || c.id) === key);
}

/**
 * Performs PNG export with optional custom image
 * @param {File|null} imageFile - Custom image file or null for default
 */
async function performPngExport(imageFile) {
  const pending = browserState.pendingPngExport;
  if (!pending) {
    toastr.error("No export pending", "VectHare");
    return;
  }

  browserState.pendingPngExport = null;

  try {
    toastr.info("Preparing PNG export...", "VectHare");

    // Get export data
    const exportData = await exportCollection(
      pending.collectionId,
      browserState.settings,
      {
        backend: pending.backend,
        source: pending.source,
        model: pending.model,
      },
    );

    // Convert custom image to PNG if provided
    let pngData = null;
    if (imageFile) {
      toastr.info("Converting image...", "VectHare");
      pngData = await convertToPNG(imageFile);
    }

    // Embed data in PNG
    toastr.info("Embedding data in PNG...", "VectHare");
    const pngWithData = await embedDataInPNG(exportData, pngData);

    // Download
    const filename = `${pending.collection.name || pending.collectionId}.vecthare`;
    downloadPNG(pngWithData, filename);

    // Show compression stats
    const jsonSize = JSON.stringify(exportData).length;
    const pngSize = pngWithData.length;
    const ratio = Math.round((pngSize / jsonSize) * 100);

    toastr.success(
      `PNG export complete!\n${exportData.stats.chunkCount} chunks\n` +
        `Original: ${formatBytes(jsonSize)}\n` +
        `PNG: ${formatBytes(pngSize)} (${ratio}%)`,
      "VectHare Export",
    );
  } catch (error) {
    console.error("VectHare: PNG export failed", error);
    toastr.error(`PNG export failed: ${error.message}`, "VectHare");
  }
}

/**
 * Formats bytes to human readable string
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

/**
 * Escapes HTML special characters to prevent XSS
 * @param {string} text Text to escape
 * @returns {string} Escaped text
 */

/**
 * Binds events for collection card actions
 */
function bindCollectionCardEvents() {
  // Toggle enabled/disabled
  $(".vecthare-action-toggle")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const currentEnabled = $(this).data("enabled");
      const newEnabled = !currentEnabled;

      setCollectionEnabled(collectionKey, newEnabled);

      // Update UI
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        collection.enabled = newEnabled;
      }

      renderCollections();

      toastr.success(
        `Collection ${newEnabled ? "enabled" : "paused"}`,
        "VectHare",
      );
    });

  // Delete collection - uses unified deleteCollection() to handle all 3 stores
  $(".vecthare-action-delete")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      const confirmed = confirm(
        `Delete collection "${collection.name}"?\n\n` +
          `This will remove ${collection.chunkCount} chunks from the vector index.\n` +
          `This action cannot be undone.`,
      );

      if (!confirmed) return;

      try {
        // Use unified delete function - handles vectors, registry, AND metadata
        const collectionSettings = {
          ...browserState.settings,
          vector_backend: collection.backend,
          source: collection.source,
          collection_locator: getCollectionMeta(collection.registryKey).storageLocator || { backend: collection.backend, source: collection.source, model: collection.model ?? "", collectionId: collection.id },
        };

        const result = await deleteCollection(
          collection.id,
          collectionSettings,
          collection.registryKey,
        );

        // Remove from state
        browserState.collections = browserState.collections.filter(
          (c) => (c.registryKey || c.id) !== collectionKey,
        );

        // Re-render
        renderCollections();

        if (result.success) {
          toastr.success(`Deleted collection "${collection.name}"`, "VectHare");
        } else {
          toastr.warning(
            `Partial deletion: ${result.errors.join(", ")}`,
            "VectHare",
          );
        }
      } catch (error) {
        console.error("VectHare: Failed to delete collection", error);
        toastr.error(`Failed to delete collection: ${error.message}`, "VectHare");
      }
    });

  // Open folder
  $(".vecthare-action-open-folder")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      try {
        const response = await pluginRequest('/open-folder', { body: {
            collectionId: collection.id,
            backend: collection.backend,
            source: collection.source,
          } });

        if (!response.ok) {
          throw new Error(`Failed to open folder: ${response.statusText}`);
        }

        toastr.success("Opened collection folder", "VectHare");
      } catch (error) {
        console.error("VectHare: Failed to open folder", error);
        toastr.error(`Failed to open folder: ${error.message}`, "VectHare");
      }
    });

  // Visualize chunks
  $(".vecthare-action-visualize")
    .off("click")
    .on("click", async function (e) {
      logger.debug("test");
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection) return;

      try {
        toastr.info("Loading chunks...", "VectHare");

        // Use the collection's actual backend, not the global setting
        // This ensures we query Standard collections with Standard backend, etc.
        if (!collection.backend) {
          toastr.error(
            "Collection has no backend defined - this is a bug",
            "VectHare",
          );
          console.error("VectHare: Collection missing backend:", collection);
          return;
        }

        const collectionSettings = {
          ...browserState.settings,
          vector_backend: collection.backend,
          collection_locator: getCollectionMeta(collection.registryKey).storageLocator || { backend: collection.backend, source: collection.source, model: collection.model ?? "", collectionId: collection.id },
        };

        // Use unified plugin endpoint
        const requestBody = {
          backend: collection.backend || "vectra",
          collectionId: collection.id,
          source: collection.source || "transformers",
          model: collection.model || "",
          limit: 1000, // Get first 1000 chunks
        };

        logger.debug("VectHare DB Browser: Requesting chunks with:", requestBody);

        const response = await pluginRequest('/chunks/list', { body: requestBody });

        if (!response.ok) {
          throw new Error(`Failed to list chunks: ${response.statusText}`);
        }

        const data = await response.json();
        // Support all plugin response shapes: items (new), chunks/results (older/backends)
        const results = data.items || data.chunks || data.results || [];

        if (!results || results.length === 0) {
          toastr.warning("No chunks found in this collection", "VectHare");
          return;
        }

        // Format chunks for visualizer
        const chunks = results.map((item, idx) => ({
          hash: item.hash,
          index: item.index ?? idx,
          text: item.text || item.metadata?.text || "No text available",
          score: 1.0,
          similarity: 1.0,
          messageAge: item.metadata?.messageAge,
          decayApplied: false,
          decayMultiplier: 1.0,
          metadata: item.metadata, // Pass through all metadata including keywords
        }));

        // Pass collection-specific settings so visualizer uses correct backend for edits/deletes
        // Include collection type so visualizer knows if this is a chat (for Scenes tab)
        openVisualizer(
          { chunks, collectionType: collection.type },
          collection.id,
          collectionSettings,
        );
      } catch (error) {
        console.error("VectHare: Failed to load chunks", error);
        toastr.error(`Failed to load chunks: ${error.message}`, "VectHare");
      }
    });

  // Export toggle - show/hide export options
  $(".vecthare-action-export-toggle")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const $dropdown = $(this).closest(".vecthare-export-dropdown");
      const isExpanded = $dropdown.hasClass("expanded");

      // Close any other open dropdowns
      $(".vecthare-export-dropdown.expanded")
        .not($dropdown)
        .removeClass("expanded");

      // Toggle this one
      $dropdown.toggleClass("expanded", !isExpanded);
    });

  // Close export dropdown when clicking elsewhere
  $(document)
    .off("click.vecthare-export")
    .on("click.vecthare-export", function (e) {
      if (!$(e.target).closest(".vecthare-export-dropdown").length) {
        $(".vecthare-export-dropdown.expanded").removeClass("expanded");
      }
    });

  // Export collection (JSON)
  $(".vecthare-action-export")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collectionId = $(this).data("collection-id");
      const backend = $(this).data("backend");
      const source = $(this).data("source");
      const model = $(this).data("model");

      const collection = findCollectionByKey(collectionKey);
      if (!collection) return;

      try {
        toastr.info("Exporting collection...", "VectHare");

        const exportData = await exportCollection(
          collectionId,
          browserState.settings,
          {
            backend,
            source,
            model,
          },
        );

        downloadExport(exportData, collection.name || collectionId);

        toastr.success(
          `Exported ${exportData.stats.chunkCount} chunks (${exportData.stats.chunksWithVectors} with vectors)`,
          "VectHare Export",
        );
      } catch (error) {
        console.error("VectHare: Export failed", error);
        toastr.error(`Export failed: ${error.message}`, "VectHare");
      }
    });

  // Export collection (PNG)
  $(".vecthare-action-export-png")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collectionId = $(this).data("collection-id");
      const backend = $(this).data("backend");
      const source = $(this).data("source");
      const model = $(this).data("model");

      const collection = findCollectionByKey(collectionKey);
      if (!collection) return;

      // Store export context for image picker callback
      browserState.pendingPngExport = {
        collectionKey,
        collectionId,
        backend,
        source,
        model,
        collection,
      };

      // Ask if they want to use a custom image
      const useCustomImage = confirm(
        "Export as PNG\n\n" +
          "Would you like to use a custom image?\n\n" +
          "• Click OK to choose an image file\n" +
          "• Click Cancel to use default VectHare image",
      );

      if (useCustomImage) {
        $("#vecthare_png_image_picker").click();
      } else {
        // Export with default image
        await performPngExport(null);
      }
    });

  // PNG image picker handler
  $("#vecthare_png_image_picker")
    .off("change")
    .on("change", async function (e) {
      const file = e.target.files[0];
      $(this).val(""); // Reset for next use

      if (!file) {
        browserState.pendingPngExport = null;
        return;
      }

      await performPngExport(file);
    });

  // Activation editor (triggers + conditions)
  $(".vecthare-action-activation")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        openActivationEditor(collection.id, collection.name);
      }
    });

  // Rename collection
  $(".vecthare-action-rename")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);
      if (collection) {
        openRenameDialog(collection.id, collection.name);
      }
    });

  $(".vecthare-action-embedding").off("click").on("click", function (e) {
    e.stopPropagation();
    const collection = findCollectionByKey($(this).data("collection-key"));
    if (collection) openEmbeddingMigrationDialog(collection, browserState.settings, refreshCollections);
  });

  $(".vecthare-action-duplicate").off("click").on("click", async function (e) {
    e.stopPropagation();
    const collection = findCollectionByKey($(this).data("collection-key"));
    if (!collection) return;
    openCollectionDuplicateDialog(collection, browserState.settings, () => refreshCollections());
  });

  // Switch model (for collections with multiple embedding models)
  $(".vecthare-action-switch-model")
    .off("click")
    .on("click", async function (e) {
      e.stopPropagation();
      const collectionKey = $(this).data("collection-key");
      const collection = findCollectionByKey(collectionKey);

      if (!collection || !collection.models || collection.models.length < 2) {
        return;
      }

      openModelSwitcher(collection);
    });
}

/**
 * Updates stats footer
 * @param {number} collectionCount Number of collections shown
 * @param {number} chunkCount Total chunks
 */
function updateStats(collectionCount, chunkCount) {
  const statsText =
    collectionCount === 0
      ? "No collections"
      : `${collectionCount} collection${collectionCount === 1 ? "" : "s"}, ${chunkCount} total chunks`;

  $("#vecthare_browser_stats_text").text(statsText);
}

