/**
 * Database browser bulk tab: enable, disable or delete many collections at once.
 */

import {
    setCollectionEnabled,
    deleteCollection,
} from "../core/collection-loader.js";
import {
    exportCollection,
    downloadExport,
} from "../core/collection-export.js";
import { escapeHtml } from "../utils/html.js";
import { icons } from "./icons.js";
import { browserState } from "./database-browser-state.js";
import { refreshCollections, renderCollections } from "./database-browser.js";

let bulkEventsBound = false;

/** Lets the next open re-bind events after the modal was rebuilt. */
export function resetBulkEventsBound() {
  bulkEventsBound = false;
}

// ============================================================================
// BULK OPERATIONS TAB FUNCTIONS
// ============================================================================

/**
 * Renders bulk operations list
 */
export function renderBulkList() {
  const filter = browserState.bulkFilter;
  let collections = [...browserState.collections];

  // Apply filter
  if (filter === "enabled") {
    collections = collections.filter((c) => c.enabled);
  } else if (filter === "disabled") {
    collections = collections.filter((c) => !c.enabled);
  }

  if (collections.length === 0) {
    $("#vecthare_bulk_list").html(`
            <div class="vecthare-bulk-empty">
                ${icons.folder(48)}
                <p>No collections match the current filter</p>
            </div>
        `);
    return;
  }

  let html = "";
  for (const collection of collections) {
    const uniqueKey = collection.registryKey || collection.id;
    const isSelected = browserState.bulkSelected.has(uniqueKey);

    html += `
            <div class="vecthare-bulk-item ${isSelected ? "selected" : ""}" data-key="${uniqueKey}">
                <label class="vecthare-bulk-checkbox">
                    <input type="checkbox" ${isSelected ? "checked" : ""} data-key="${uniqueKey}">
                </label>
                <div class="vecthare-bulk-item-info">
                    <span class="vecthare-bulk-item-name">${escapeHtml(collection.name || collection.id)}</span>
                    <span class="vecthare-bulk-item-meta">
                        ${collection.chunkCount || 0} chunks •
                        ${collection.enabled ? `${icons.toggleRight(12)} Enabled` : `${icons.toggleLeft(12)} Disabled`}
                    </span>
                </div>
            </div>
        `;
  }

  $("#vecthare_bulk_list").html(html);
  updateBulkCount();
}

/**
 * Binds bulk operations events
 */
export function bindBulkEvents() {
  if (bulkEventsBound) return;
  bulkEventsBound = true;

  // Filter change
  $("#vecthare_bulk_filter")
    .off("change")
    .on("change", function () {
      browserState.bulkFilter = $(this).val();
      browserState.bulkSelected.clear();
      renderBulkList();
    });

  // Select all checkbox
  $("#vecthare_bulk_select_all")
    .off("change")
    .on("change", function () {
      const isChecked = $(this).is(":checked");
      const filter = browserState.bulkFilter;
      let collections = [...browserState.collections];

      if (filter === "enabled") {
        collections = collections.filter((c) => c.enabled);
      } else if (filter === "disabled") {
        collections = collections.filter((c) => !c.enabled);
      }

      browserState.bulkSelected.clear();
      if (isChecked) {
        collections.forEach((c) =>
          browserState.bulkSelected.add(c.registryKey || c.id),
        );
      }

      renderBulkList();
    });

  // Individual checkbox clicks (delegated)
  $("#vecthare_bulk_list")
    .off("change", 'input[type="checkbox"]')
    .on("change", 'input[type="checkbox"]', function () {
      const key = $(this).data("key");
      if ($(this).is(":checked")) {
        browserState.bulkSelected.add(key);
      } else {
        browserState.bulkSelected.delete(key);
      }
      updateBulkCount();
      $(this)
        .closest(".vecthare-bulk-item")
        .toggleClass("selected", $(this).is(":checked"));
    });

  // Bulk enable
  $("#vecthare_bulk_enable")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      for (const key of browserState.bulkSelected) {
        setCollectionEnabled(key, true);
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (collection) collection.enabled = true;
      }

      toastr.success(
        `Enabled ${browserState.bulkSelected.size} collection(s)`,
        "VectHare",
      );
      renderBulkList();
      renderCollections();
    });

  // Bulk disable
  $("#vecthare_bulk_disable")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      for (const key of browserState.bulkSelected) {
        setCollectionEnabled(key, false);
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (collection) collection.enabled = false;
      }

      toastr.success(
        `Disabled ${browserState.bulkSelected.size} collection(s)`,
        "VectHare",
      );
      renderBulkList();
      renderCollections();
    });

  // Bulk export
  $("#vecthare_bulk_export")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      const confirmed = confirm(
        `Export ${browserState.bulkSelected.size} collection(s)?\n\nEach collection will be downloaded as a separate file.`,
      );
      if (!confirmed) return;

      toastr.info(
        `Exporting ${browserState.bulkSelected.size} collection(s)...`,
        "VectHare",
      );

      let successCount = 0;
      for (const key of browserState.bulkSelected) {
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (!collection) continue;

        try {
          const exportData = await exportCollection(
            collection.id,
            browserState.settings,
            {
              backend: collection.backend,
              source: collection.source || "transformers",
              model: collection.model || "",
            },
          );

          downloadExport(exportData, collection.name || collection.id);
          successCount++;
        } catch (error) {
          console.error(`VectHare: Failed to export ${collection.id}`, error);
        }
      }

      toastr.success(`Exported ${successCount} collection(s)`, "VectHare");
    });

  // Bulk delete - uses unified deleteCollection()
  $("#vecthare_bulk_delete")
    .off("click")
    .on("click", async function () {
      if (browserState.bulkSelected.size === 0) return;

      const confirmed = confirm(
        `⚠️ DELETE ${browserState.bulkSelected.size} COLLECTION(S)?\n\n` +
          `This will permanently delete all vectors in these collections.\n` +
          `This action CANNOT be undone!\n\n` +
          `Type "DELETE" to confirm.`,
      );

      if (!confirmed) return;

      const confirmText = prompt("Type DELETE to confirm:");
      if (confirmText !== "DELETE") {
        toastr.info("Deletion cancelled", "VectHare");
        return;
      }

      toastr.info(
        `Deleting ${browserState.bulkSelected.size} collection(s)...`,
        "VectHare",
      );

      let successCount = 0;
      let partialCount = 0;
      for (const key of browserState.bulkSelected) {
        const collection = browserState.collections.find(
          (c) => (c.registryKey || c.id) === key,
        );
        if (!collection) continue;

        try {
          const collectionSettings = {
            ...browserState.settings,
            vector_backend: collection.backend,
            source: collection.source,
          };
          const result = await deleteCollection(
            collection.id,
            collectionSettings,
            collection.registryKey,
          );
          if (result.success) {
            successCount++;
          } else {
            partialCount++;
          }
        } catch (error) {
          console.error(`VectHare: Failed to delete ${collection.id}`, error);
        }
      }

      browserState.bulkSelected.clear();
      await refreshCollections();
      renderBulkList();

      if (partialCount > 0) {
        toastr.warning(
          `Deleted ${successCount}, partial: ${partialCount}`,
          "VectHare",
        );
      } else {
        toastr.success(`Deleted ${successCount} collection(s)`, "VectHare");
      }
    });
}

/**
 * Updates bulk selection count and button states
 */
function updateBulkCount() {
  const count = browserState.bulkSelected.size;
  $("#vecthare_bulk_count").text(`${count} selected`);

  // Enable/disable buttons based on selection
  const hasSelection = count > 0;
  $(
    "#vecthare_bulk_enable, #vecthare_bulk_disable, #vecthare_bulk_export, #vecthare_bulk_delete",
  ).prop("disabled", !hasSelection);
}
