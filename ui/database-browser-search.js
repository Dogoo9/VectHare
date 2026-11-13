/**
 * Database browser search tab: semantic search across collections and keyword filtering.
 */

import {
    queryMultipleCollections,
} from "../core/core-vector-api.js";
import {
    getCollectionMeta,
} from "../core/collection-metadata.js";
import { icons } from "./icons.js";
import { openVisualizer } from "./chunk-visualizer.js";
import { escapeHtml } from "../utils/html.js";
import { pluginRequest } from '../backends/similharity-backend.js';
import { logger } from '../utils/logger.js';
import { browserState } from "./database-browser-state.js";
import { findCollectionByKey } from "./database-browser.js";

// Event binding flags (module-level for proper reset on modal close)
let searchEventsBound = false;

/** Lets the next open re-bind events after the modal was rebuilt. */
export function resetSearchEventsBound() {
  searchEventsBound = false;
}

// ============================================================================
// SEARCH TAB FUNCTIONS
// ============================================================================

/**
 * Binds search tab events
 */
export function bindSearchEvents() {
  if (searchEventsBound) return;
  searchEventsBound = true;

  // Search button click
  $("#vecthare_search_btn").off("click").on("click", performSearch);

  // Enter key in search input
  $("#vecthare_semantic_search")
    .off("keydown")
    .on("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        performSearch();
      }
    });

  // Keyword filter events
  $("#vecthare_scan_keywords").off("click").on("click", scanKeywords);
  $("#vecthare_clear_keyword_filter").off("click").on("click", clearKeywordFilter);
  $("#vecthare_keyword_filter").off("input").on("input", updateKeywordFilterFromInput);
}

/**
 * Scans all collections for keywords
 */
async function scanKeywords() {
  const $btn = $("#vecthare_scan_keywords");
  const $tags = $("#vecthare_keyword_tags");

  $btn.prop("disabled", true).html('<i class="fa-solid fa-spinner fa-spin"></i> Scanning...');
  $tags.html('<span class="vecthare-keyword-hint">Scanning collections...</span>');

  try {
    const enabledOnly = $("#vecthare_search_enabled_only").is(":checked");
    let collectionsToScan = browserState.collections;

    if (enabledOnly) {
      collectionsToScan = collectionsToScan.filter(c => c.enabled);
    }

    const keywordCounts = new Map();

    for (const collection of collectionsToScan) {
      try {
        const response = await pluginRequest('/chunks/list', { body: {
            backend: collection.backend || "vectra",
            collectionId: collection.id,
            source: collection.source || "transformers",
            model: collection.model || "",
            limit: 500,
          } });

        if (!response.ok) continue;

        const data = await response.json();
        const items = data.items || [];

        for (const item of items) {
          const keywords = item.metadata?.keywords || item.keywords || [];
          for (const kw of keywords) {
            const text = (typeof kw === 'object' ? kw.text : kw)?.toLowerCase();
            if (text) {
              keywordCounts.set(text, (keywordCounts.get(text) || 0) + 1);
            }
          }
        }
      } catch (err) {
        console.warn(`VectHare: Failed to scan keywords from ${collection.id}:`, err);
      }
    }

    // Sort by count and store
    browserState.availableKeywords = Array.from(keywordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([text, count]) => ({ text, count }));

    renderKeywordTags();

    if (browserState.availableKeywords.length === 0) {
      $tags.html('<span class="vecthare-keyword-hint">No keywords found in scanned collections</span>');
    } else {
      toastr.success(`Found ${browserState.availableKeywords.length} unique keywords`, "VectHare");
    }
  } catch (error) {
    console.error("VectHare: Keyword scan failed", error);
    $tags.html('<span class="vecthare-keyword-hint vecthare-error">Scan failed</span>');
    toastr.error("Failed to scan keywords", "VectHare");
  } finally {
    $btn.prop("disabled", false).html('<i class="fa-solid fa-sync"></i> Scan');
  }
}

/**
 * Renders clickable keyword tags
 */
function renderKeywordTags() {
  const $tags = $("#vecthare_keyword_tags");
  const keywords = browserState.availableKeywords;

  if (keywords.length === 0) {
    $tags.html('<span class="vecthare-keyword-hint">No keywords available</span>');
    return;
  }

  // Show top 30 keywords with counts
  const displayKeywords = keywords.slice(0, 30);
  const currentFilter = browserState.keywordFilter.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);

  let html = displayKeywords.map(kw => {
    const isActive = currentFilter.includes(kw.text);
    return `<span class="vecthare-keyword-tag ${isActive ? 'active' : ''}"
                  data-keyword="${escapeHtml(kw.text)}"
                  title="${kw.count} occurrence(s)">
              ${escapeHtml(kw.text)} <small>(${kw.count})</small>
            </span>`;
  }).join('');

  if (keywords.length > 30) {
    html += `<span class="vecthare-keyword-more">+${keywords.length - 30} more</span>`;
  }

  $tags.html(html);

  // Bind click events on tags
  $tags.find(".vecthare-keyword-tag").off("click").on("click", function() {
    const keyword = $(this).data("keyword");
    toggleKeywordFilter(keyword);
  });
}

/**
 * Toggles a keyword in the filter
 */
function toggleKeywordFilter(keyword) {
  const currentFilter = browserState.keywordFilter.toLowerCase().split(',').map(k => k.trim()).filter(Boolean);
  const idx = currentFilter.indexOf(keyword.toLowerCase());

  if (idx >= 0) {
    currentFilter.splice(idx, 1);
  } else {
    currentFilter.push(keyword.toLowerCase());
  }

  browserState.keywordFilter = currentFilter.join(', ');
  $("#vecthare_keyword_filter").val(browserState.keywordFilter);
  renderKeywordTags();
}

/**
 * Clears the keyword filter
 */
function clearKeywordFilter() {
  browserState.keywordFilter = '';
  $("#vecthare_keyword_filter").val('');
  renderKeywordTags();
}

/**
 * Updates keyword filter from input field
 */
function updateKeywordFilterFromInput() {
  browserState.keywordFilter = $("#vecthare_keyword_filter").val();
  renderKeywordTags();
}

/**
 * Filters search results by keywords
 * @param {object} results Search results by collection
 * @returns {object} Filtered results
 */
function filterResultsByKeywords(results) {
  const filterKeywords = browserState.keywordFilter.toLowerCase()
    .split(',')
    .map(k => k.trim())
    .filter(Boolean);

  if (filterKeywords.length === 0) {
    return results;
  }

  const filtered = {};

  for (const [collectionId, collectionResults] of Object.entries(results)) {
    if (!collectionResults?.hashes?.length) continue;

    const filteredHashes = [];
    const filteredMetadata = [];

    for (let i = 0; i < collectionResults.hashes.length; i++) {
      const metadata = collectionResults.metadata?.[i] || {};
      const chunkKeywords = (metadata.keywords || []).map(kw =>
        (typeof kw === 'object' ? kw.text : kw)?.toLowerCase()
      ).filter(Boolean);

      // Check if chunk has ANY of the filter keywords
      const hasMatch = filterKeywords.some(fk => chunkKeywords.includes(fk));

      if (hasMatch) {
        filteredHashes.push(collectionResults.hashes[i]);
        filteredMetadata.push(metadata);
      }
    }

    if (filteredHashes.length > 0) {
      filtered[collectionId] = {
        hashes: filteredHashes,
        metadata: filteredMetadata
      };
    }
  }

  return filtered;
}

/**
 * Performs semantic search across collections
 */
async function performSearch() {
  const query = $("#vecthare_semantic_search").val().trim();
  if (!query) {
    toastr.warning("Please enter a search query", "VectHare");
    return;
  }

  const topK = parseInt($("#vecthare_search_topk").val()) || 5;
  const threshold = parseFloat($("#vecthare_search_threshold").val()) || 0.3;
  const enabledOnly = $("#vecthare_search_enabled_only").is(":checked");

  // Get collection IDs to search
  let collectionIds = browserState.collections.map((c) => c.id);

  if (enabledOnly) {
    collectionIds = collectionIds.filter((id) => {
      const collection = browserState.collections.find((c) => c.id === id);
      return collection && collection.enabled;
    });
  }

  if (collectionIds.length === 0) {
    $("#vecthare_search_results").html(`
            <div class="vecthare-search-empty">
                ${icons.search(48)}
                <p>No collections available to search</p>
            </div>
        `);
    return;
  }

  // Show loading state
  browserState.isSearching = true;
  $("#vecthare_search_btn")
    .prop("disabled", true)
    .html(`${icons.search(16)} Searching...`);
  $("#vecthare_search_results").html(`
        <div class="vecthare-search-loading">
            <i class="fa-solid fa-spinner fa-spin"></i> Searching ${collectionIds.length} collections...
        </div>
    `);

  try {
    const results = await queryMultipleCollections(
      collectionIds,
      query,
      topK,
      threshold,
      browserState.settings,
    );

    browserState.searchResults = results;

    // Apply keyword filter if set
    const filteredResults = filterResultsByKeywords(results);
    renderSearchResults(filteredResults, query, results);
  } catch (error) {
    console.error("VectHare: Search failed", error);
    $("#vecthare_search_results").html(`
            <div class="vecthare-search-error">
                ${icons.x(24)} Search failed: ${error.message}
            </div>
        `);
  } finally {
    browserState.isSearching = false;
    $("#vecthare_search_btn")
      .prop("disabled", false)
      .html(`${icons.search(16)} Search`);
  }
}

/**
 * Renders search results
 * @param {object} results Results from queryMultipleCollections (possibly filtered)
 * @param {string} query Original search query
 * @param {object} originalResults Original unfiltered results (for showing filter info)
 */
function renderSearchResults(results, query, originalResults = null) {
  const collectionIds = Object.keys(results);
  const totalResults = collectionIds.reduce(
    (sum, id) => sum + (results[id]?.hashes?.length || 0),
    0,
  );

  // Calculate original counts if keyword filter was applied
  const wasFiltered = originalResults && browserState.keywordFilter.trim();
  const originalTotal = originalResults
    ? Object.keys(originalResults).reduce((sum, id) => sum + (originalResults[id]?.hashes?.length || 0), 0)
    : totalResults;

  if (totalResults === 0) {
    const filterMsg = wasFiltered
      ? `<p>No results match keyword filter: "${escapeHtml(browserState.keywordFilter)}"</p><small>${originalTotal} result(s) found before filtering</small>`
      : `<p>No results found for "${escapeHtml(query)}"</p><small>Try adjusting the score threshold or search in more collections</small>`;

    $("#vecthare_search_results").html(`
            <div class="vecthare-search-empty">
                ${icons.search(48)}
                ${filterMsg}
            </div>
        `);
    return;
  }

  let summaryHtml = `<div class="vecthare-search-summary">Found ${totalResults} result(s) in ${collectionIds.length} collection(s)`;
  if (wasFiltered) {
    summaryHtml += ` <span class="vecthare-filter-badge" title="Keyword filter active">🏷️ filtered from ${originalTotal}</span>`;
  }
  summaryHtml += `</div>`;

  let html = summaryHtml;

  for (const collectionId of collectionIds) {
    const collectionResults = results[collectionId];
    if (!collectionResults?.hashes?.length) continue;

    const collection = browserState.collections.find(
      (c) => c.id === collectionId,
    );
    const collectionName = collection?.name || collectionId;
    // Use registryKey for unique identification (source:id format)
    const uniqueKey = collection.registryKey || collection.id;

    html += `
            <div class="vecthare-search-collection">
                <div class="vecthare-search-collection-header">
                    ${icons.folder(16)} ${escapeHtml(collectionName)}
                    <span class="vecthare-search-count">${collectionResults.hashes.length} result(s)</span>
                </div>
                <div class="vecthare-search-collection-results">
        `;

    for (let i = 0; i < collectionResults.hashes.length; i++) {
      const metadata = collectionResults.metadata?.[i] || {};
      const score =
        metadata.score !== undefined ? (metadata.score * 100).toFixed(1) : "?";
      const text = metadata.text || `[Hash: ${collectionResults.hashes[i]}]`;
      const preview = text.length > 200 ? text.substring(0, 200) + "..." : text;

      // Build score breakdown for hybrid search results
      const vectorScore = metadata.vectorScore !== undefined ? (metadata.vectorScore * 100).toFixed(0) : null;
      const textScore = metadata.textScore !== undefined ? (metadata.textScore * 100).toFixed(0) : null;
      const isHybrid = metadata.hybridSearch || (vectorScore !== null && textScore !== null);

      let scoreDisplay = `<div class="vecthare-search-result-score">${score}%</div>`;
      if (isHybrid) {
        scoreDisplay = `
          <div class="vecthare-search-result-score-hybrid">
            <div class="vecthare-score-main">${score}%</div>
            <div class="vecthare-score-breakdown">
              <span class="vecthare-score-vector" title="Semantic similarity">🔷${vectorScore || '?'}%</span>
              <span class="vecthare-score-text" title="Keyword match">📝${textScore || '0'}%</span>
            </div>
          </div>`;
      }

      // Build keywords display
      const chunkKeywords = metadata.keywords || [];
      let keywordsHtml = '';
      if (chunkKeywords.length > 0) {
        const keywordTags = chunkKeywords.slice(0, 5).map(kw => {
          const text = typeof kw === 'object' ? kw.text : kw;
          return `<span class="vecthare-result-keyword">${escapeHtml(text)}</span>`;
        }).join('');
        const moreCount = chunkKeywords.length > 5 ? `<span class="vecthare-result-keyword-more">+${chunkKeywords.length - 5}</span>` : '';
        keywordsHtml = `<div class="vecthare-result-keywords">${keywordTags}${moreCount}</div>`;
      }

      html += `
                <div class="vecthare-search-result" data-collection="${collectionId}" data-hash="${collectionResults.hashes[i]}">
                    ${scoreDisplay}
                    <div class="vecthare-search-result-content">
                        <div class="vecthare-search-result-text">${escapeHtml(preview)}</div>
                        ${keywordsHtml}
                    </div>
                </div>

                <button class="vecthare-btn-sm vecthare-action-visualize"
                        data-collection-key="${uniqueKey}"
                        data-backend="${collection.backend}"
                        data-source="${collection.source || "transformers"}"
                        title="View and edit chunks in this collection">
                    ${icons.eye(16)} View Chunks
                </button>
            `;
    }

    html += `</div></div>`;
  }

  $("#vecthare_search_results").html(html);
  // sloppy, temporary fix to replicate OG chunk link functionality (1091)
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
        const response = await pluginRequest('/chunks/list', { body: {
            backend: collection.backend || "vectra",
            collectionId: collection.id,
            source: collection.source || "transformers",
            model: collection.model || "",
            limit: 1000, // Get first 1000 chunks
          } });

        if (!response.ok) {
          throw new Error(`Failed to list chunks: ${response.statusText}`);
        }

        const data = await response.json();
        const results = data.items || [];

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
}
