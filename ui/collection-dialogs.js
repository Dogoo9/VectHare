/**
 * Small collection dialogs: rename and model switcher.
 */

import {
    setCollectionMeta,
} from "../core/collection-metadata.js";
import { escapeHtml } from "../utils/html.js";
import { browserState } from "./database-browser-state.js";
import { refreshCollections, renderCollections } from "./database-browser.js";

// ============================================================================
// RENAME DIALOG
// ============================================================================

/**
 * Opens a rename dialog for a collection
 * @param {string} collectionId Collection ID
 * @param {string} currentName Current display name
 */
export function openRenameDialog(collectionId, currentName) {
  // Create modal if needed
  if ($("#vecthare_rename_modal").length === 0) {
    const modalHtml = `
            <div id="vecthare_rename_modal" class="vecthare-modal">
                <div class="vecthare-modal-content vecthare-rename-dialog popup">
                    <div class="vecthare-modal-header">
                        <h3>✏️ Rename Collection</h3>
                        <button class="vecthare-btn-icon" id="vecthare_rename_close">✕</button>
                    </div>
                    <div class="vecthare-rename-body">
                        <label for="vecthare_rename_input">New name:</label>
                        <input type="text" id="vecthare_rename_input" placeholder="Enter new name..." autocomplete="off">
                        <small class="vecthare-rename-hint">Leave empty to reset to auto-generated name</small>
                    </div>
                    <div class="vecthare-modal-footer">
                        <button class="vecthare-btn" id="vecthare_rename_cancel">Cancel</button>
                        <button class="vecthare-btn vecthare-btn-primary" id="vecthare_rename_save">Save</button>
                    </div>
                </div>
            </div>
        `;
    $("body").append(modalHtml);

    // Bind events
    $("#vecthare_rename_close, #vecthare_rename_cancel").on(
      "click",
      closeRenameDialog,
    );
    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $("#vecthare_rename_modal").on("mousedown touchstart", function (e) {
      e.stopPropagation();
    });
    // Close on background click
    $("#vecthare_rename_modal").on("click", function (e) {
      if (e.target === this) closeRenameDialog();
    });
    $("#vecthare_rename_input").on("keydown", function (e) {
      if (e.key === "Enter") {
        e.preventDefault();
        $("#vecthare_rename_save").click();
      } else if (e.key === "Escape") {
        closeRenameDialog();
      }
    });
  }

  // Store collection ID for save handler
  $("#vecthare_rename_modal").data("collection-id", collectionId);

  // Set current name
  $("#vecthare_rename_input").val(currentName);

  // Bind save handler (rebind each time to get fresh collectionId)
  $("#vecthare_rename_save")
    .off("click")
    .on("click", function () {
      const newName = $("#vecthare_rename_input").val().trim();
      const id = $("#vecthare_rename_modal").data("collection-id");

      // Save the new name (or null to reset)
      setCollectionMeta(id, { displayName: newName || null });

      // Update local state
      const collection = browserState.collections.find((c) => c.id === id);
      if (collection) {
        collection.name = newName || collection.name; // Will refresh properly on next load
      }

      closeRenameDialog();
      refreshCollections(); // Reload to get updated names

      if (newName) {
        toastr.success(`Renamed to "${newName}"`, "VectHare");
      } else {
        toastr.success("Reset to auto-generated name", "VectHare");
      }
    });

  // Show modal and focus input
  $("#vecthare_rename_modal").fadeIn(200, function () {
    $("#vecthare_rename_input").focus().select();
  });
}

/**
 * Closes the rename dialog
 */
function closeRenameDialog() {
  $("#vecthare_rename_modal").fadeOut(200);
}

// ============================================================================
// MODEL SWITCHER
// ============================================================================

/**
 * Opens the model switcher modal
 * @param {object} collection Collection object with models array
 */
export function openModelSwitcher(collection) {
  // Create modal if it doesn't exist
  if ($("#vecthare_model_switcher_modal").length === 0) {
    const modalHtml = `
            <div id="vecthare_model_switcher_modal" class="vecthare-modal">
                <div class="vecthare-modal-content vecthare-model-switcher-content popup">
                    <div class="vecthare-modal-header">
                        <h3><i class="fa-solid fa-code-branch"></i> Switch Embedding Model</h3>
                        <button class="vecthare-btn-icon" id="vecthare_model_switcher_close">✕</button>
                    </div>
                    <div class="vecthare-modal-body">
                        <p class="vecthare-model-switcher-desc">
                            Select which embedding model to use for this collection.
                            Each model may have different vectors from different embedding providers.
                        </p>
                        <div id="vecthare_model_list" class="vecthare-model-list"></div>
                    </div>
                </div>
            </div>
        `;
    $("body").append(modalHtml);

    // Bind close
    $("#vecthare_model_switcher_close").on("click", closeModelSwitcher);
    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $("#vecthare_model_switcher_modal").on("mousedown touchstart", function (e) {
      e.stopPropagation();
    });
    // Close on background click
    $("#vecthare_model_switcher_modal").on("click", function (e) {
      if (e.target === this) closeModelSwitcher();
    });
  }

  // Store collection reference
  $("#vecthare_model_switcher_modal").data("collection", collection);

  // Build model list
  const modelListHtml = collection.models
    .map((model) => {
      const isActive = model.path === collection.model;
      const modelName = model.name || "(default)";
      const chunkLabel = model.chunkCount === 1 ? "chunk" : "chunks";

      return `
            <div class="vecthare-model-item ${isActive ? "vecthare-model-active" : ""}"
                 data-model-path="${escapeHtml(model.path)}">
                <div class="vecthare-model-item-info">
                    <span class="vecthare-model-name">
                        ${isActive ? '<i class="fa-solid fa-check"></i>' : '<i class="fa-solid fa-cube"></i>'}
                        ${escapeHtml(modelName)}
                    </span>
                    <span class="vecthare-model-chunks">${model.chunkCount} ${chunkLabel}</span>
                </div>
                ${
                  isActive
                    ? '<span class="vecthare-model-badge-current">Current</span>'
                    : '<button class="vecthare-btn-sm vecthare-model-select-btn">Set as Primary</button>'
                }
            </div>
        `;
    })
    .join("");

  $("#vecthare_model_list").html(modelListHtml);

  // Bind selection
  $(".vecthare-model-select-btn")
    .off("click")
    .on("click", function (e) {
      e.stopPropagation();
      const modelPath = $(this)
        .closest(".vecthare-model-item")
        .data("model-path");
      const coll = $("#vecthare_model_switcher_modal").data("collection");

      // Update collection
      coll.model = modelPath;
      const modelInfo = coll.models.find((m) => m.path === modelPath);
      if (modelInfo) {
        coll.chunkCount = modelInfo.chunkCount;
      }

      // Persist
      setCollectionMeta(coll.registryKey || coll.id, {
        preferredModel: modelPath,
        storageLocator: { backend: coll.backend, source: coll.source, model: modelPath, collectionId: coll.id },
      });

      toastr.success(
        `Set primary model: ${modelPath || "(default)"}`,
        "VectHare",
      );
      closeModelSwitcher();
      renderCollections();
    });

  // Show
  $("#vecthare_model_switcher_modal").fadeIn(200);
}

/**
 * Closes the model switcher modal
 */
function closeModelSwitcher() {
  $("#vecthare_model_switcher_modal").fadeOut(200);
}
