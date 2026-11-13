/**
 * Activation editor: per-collection triggers, conditions, temporal weighting and locks.
 */

import { getCurrentChatId, eventSource, event_types } from "../../../../../script.js";
import {
    getCollectionConditions,
    setCollectionConditions,
    getCollectionTriggers,
    getCollectionMeta,
    setCollectionMeta,
    getCollectionDecaySettings,
    getCollectionLocks,
    setCollectionLock,
    removeCollectionLock,
    isCollectionLockedToChat,
    getCollectionLockCount,
    getCollectionCharacterLocks,
    setCollectionCharacterLock,
    removeCollectionCharacterLock,
    isCollectionLockedToCharacter,
    getCollectionCharacterLockCount,
    getChatCollectionPolicy,
    setChatCollectionPolicy,
    addCollectionToChatPolicy,
    removeCollectionFromChatPolicy,
    isCollectionSelectedForChat,
} from "../core/collection-metadata.js";
import { getContext } from "../../../../extensions.js";
import {
  VALID_EMOTIONS,
  VALID_GENERATION_TYPES,
  getExpressionsExtensionStatus,
} from "../core/conditional-activation.js";
import { world_names, loadWorldInfo } from "../../../../world-info.js";
import { escapeHtml } from "../utils/html.js";
import { refreshCollections } from "./database-browser.js";

// ============================================================================
// CONDITIONS EDITOR
// ============================================================================

// Collection-level condition types (11 types)
// Note: "keyword" renamed to "pattern" - triggers handle simple keywords,
// this is for advanced regex/pattern matching with custom scan depth
const CONDITION_TYPES = [
  {
    value: "pattern",
    label: "🔍 Pattern Match",
    desc: "Advanced regex/pattern in messages",
  },
  { value: "speaker", label: "🗣️ Speaker", desc: "Match by who spoke last" },
  {
    value: "characterPresent",
    label: "👥 Character Present",
    desc: "Check if character spoke recently",
  },
  {
    value: "messageCount",
    label: "#️⃣ Message Count",
    desc: "Conversation length check",
  },
  { value: "emotion", label: "😊 Emotion", desc: "Detect emotional tone" },
  { value: "isGroupChat", label: "👪 Group Chat", desc: "Group vs 1-on-1" },
  {
    value: "generationType",
    label: "⚙️ Gen Type",
    desc: "Normal, swipe, continue, etc.",
  },
  {
    value: "lorebookActive",
    label: "📖 Lorebook",
    desc: "Check if lorebook entry active",
  },
  {
    value: "swipeCount",
    label: "👆 Swipe Count",
    desc: "Swipes on last message",
  },
  {
    value: "timeOfDay",
    label: "🕐 Time of Day",
    desc: "Real-world time window",
  },
  {
    value: "randomChance",
    label: "🎲 Random",
    desc: "Probabilistic activation",
  },
];

// ============================================================================
// COLLECTION SETTINGS EDITOR (Activation + Triggers + Conditions + Decay)
// ============================================================================

let activationEditorState = {
  collectionId: null,
  collectionName: null,
  collectionType: "unknown",
  alwaysActive: false,
  triggers: [],
  triggerMatchMode: "any",
  triggerCaseSensitive: false,
  triggerScanDepth: 5,
  conditions: null,
  // Temporal Weighting (decay or nostalgia)
  temporalDecay: {
    enabled: false,
    type: "decay", // 'decay' or 'nostalgia'
    mode: "exponential",
    halfLife: 50,
    linearRate: 0.01,
    minRelevance: 0.3,
    maxBoost: 1.2,
    sceneAware: false,
  },
  // Injection settings (position/depth)
  position: null, // null = use global default
  depth: null, // null = use global default
};

/**
 * Opens the collection settings editor
 * @param {string} collectionId Collection ID
 * @param {string} collectionName Display name
 */
export function openActivationEditor(collectionId, collectionName) {
  const meta = getCollectionMeta(collectionId);
  const triggerSettings = getCollectionTriggers(collectionId);
  const conditions = getCollectionConditions(collectionId);

  // Get decay settings - use type-aware defaults if not explicitly set
  const collectionType =
    meta.scope === "chat" ? "chat" : meta.type || "unknown";
  const decaySettings = getCollectionDecaySettings(collectionId);

  activationEditorState = {
    collectionId,
    collectionName,
    collectionType,
    alwaysActive: meta.alwaysActive || false,
    lockMode: meta.lockMode || "prefer",
    exclusiveWhenActive: meta.exclusiveWhenActive || false,
    exclusiveScope: meta.exclusiveScope || "lorebook",
    selectedForCurrentChat: isCollectionSelectedForChat(collectionId, getCurrentChatId()),
    chatPolicy: getChatCollectionPolicy(getCurrentChatId()),
    triggers: triggerSettings.triggers || [],
    triggerMatchMode: triggerSettings.matchMode || "any",
    triggerCaseSensitive: triggerSettings.caseSensitive || false,
    triggerScanDepth: triggerSettings.scanDepth || 5,
    conditions,
    temporalDecay: {
      enabled: decaySettings.enabled,
      type: decaySettings.type || "decay",
      mode: decaySettings.mode,
      halfLife: decaySettings.halfLife,
      linearRate: decaySettings.linearRate,
      minRelevance: decaySettings.minRelevance,
      maxBoost: decaySettings.maxBoost || 1.2,
      sceneAware: decaySettings.sceneAware,
    },
    // Prompt context
    context: meta.context || "",
    xmlTag: meta.xmlTag || "",
    // Injection position/depth (null = use global default)
    position: meta.position ?? null,
    depth: meta.depth ?? null,
  };

  // Create modal if needed
  if ($("#vecthare_activation_editor_modal").length === 0) {
    createActivationEditorModal();
  }

  // Populate with current settings
  renderActivationEditor();

  $("#vecthare_activation_editor_modal").fadeIn(200);
}

/**
 * Closes the activation editor
 */
function closeActivationEditor() {
  $("#vecthare_activation_editor_modal").fadeOut(200);
  activationEditorState.collectionId = null;
}

/**
 * Creates the activation editor modal
 * Primary: Triggers (like lorebook)
 * Secondary: Advanced conditions
 */
function createActivationEditorModal() {
  const modalHtml = `
        <div id="vecthare_activation_editor_modal" class="vecthare-modal">
            <div class="vecthare-activation-editor">
                <div class="vecthare-modal-header">
                                    <h3>⚙️ Collection Settings</h3>
                                    <div style="display:flex; gap:8px; align-items:center;">
                                        <button id="vecthare_activation_lock_collection" class="vecthare-btn-sm" title="Lock this collection to the current chat">🔒 Lock to Chat</button>
                                        <button class="vecthare-btn-icon" id="vecthare_activation_close">✕</button>
                                    </div>
                                </div>

                <div class="vecthare-activation-body">
                    <div class="vecthare-activation-collection-name">
                        Collection: <strong id="vecthare_activation_collection_name"></strong>
                    </div>

                    <!-- Always Active Toggle -->
                    <div class="vecthare-activation-section vecthare-always-active">
                        <label class="vecthare-checkbox-label">
                            <input type="checkbox" id="vecthare_always_active">
                            <strong>∞ Always Active</strong>
                        </label>
                        <small>When enabled, this collection always queries (ignores triggers and conditions)</small>
                    </div>

                    <div class="vecthare-activation-section vecthare-lock-mode-section">
                        <label for="vecthare_lock_mode"><strong>🔒 Lock Behavior</strong></label>
                        <select id="vecthare_lock_mode" class="text_pole">
                            <option value="prefer">Prefer locked chats/characters</option>
                            <option value="exclusive">Only use in locked chats/characters</option>
                        </select>
                        <small>"Only use" makes locks restrictive: if this collection is locked elsewhere, it cannot activate here.</small>
                    </div>

                    <div class="vecthare-activation-section vecthare-chat-policy-section">
                        <label class="vecthare-checkbox-label">
                            <input type="checkbox" id="vecthare_force_current_chat">
                            <strong>📌 Force in Current Chat</strong>
                        </label>
                        <small>Queries this collection in the current chat without needing triggers or Always Active. Disabled collections still stay disabled.</small>
                        <label for="vecthare_chat_collection_policy" style="margin-top: 8px; display:block;">Current chat collection policy:</label>
                        <select id="vecthare_chat_collection_policy" class="text_pole">
                            <option value="normal">Normal smart activation</option>
                            <option value="prefer_selected">Prefer forced/selected collections</option>
                            <option value="only_selected">Only selected lorebook collections</option>
                        </select>
                    </div>

                    <div class="vecthare-activation-section vecthare-exclusive-section">
                        <label class="vecthare-checkbox-label">
                            <input type="checkbox" id="vecthare_exclusive_when_active">
                            <strong>🚫 Suppress peer collections when active</strong>
                        </label>
                        <select id="vecthare_exclusive_scope" class="text_pole">
                            <option value="lorebook">Suppress other lorebooks</option>
                            <option value="all">Suppress all other collections</option>
                        </select>
                        <small>Useful when a specific lorebook should be the only lorebook injected for a chat.</small>
                    </div>

                    <!-- ========================================== -->
                    <!-- PRIMARY: ACTIVATION TRIGGERS (Like Lorebook) -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-triggers-section">
                        <div class="vecthare-section-header">
                            <h4>🎯 Activation Triggers <span class="vecthare-badge-primary">Primary</span></h4>
                            <small>Simple keyword-based activation, like lorebook entries</small>
                        </div>

                        <div class="vecthare-triggers-input">
                            <label>Trigger keywords:</label>
                            <textarea id="vecthare_triggers_input"
                                      placeholder="Enter keywords, one per line or comma-separated.&#10;Supports regex: /pattern/i"
                                      rows="4"></textarea>
                        </div>

                        <div class="vecthare-triggers-options">
                            <div class="vecthare-option-row">
                                <label>Match mode:</label>
                                <select id="vecthare_trigger_match_mode">
                                    <option value="any">ANY trigger matches (OR)</option>
                                    <option value="all">ALL triggers must match (AND)</option>
                                </select>
                            </div>
                            <div class="vecthare-option-row">
                                <label>Scan depth:</label>
                                <input type="number" id="vecthare_trigger_scan_depth" min="1" max="20" value="5">
                                <small>recent messages</small>
                            </div>
                            <div class="vecthare-option-row">
                                <label class="vecthare-checkbox-label">
                                    <input type="checkbox" id="vecthare_trigger_case_sensitive">
                                    Case sensitive
                                </label>
                            </div>
                        </div>
                    </div>

                    <!-- ========================================== -->
                    <!-- SECONDARY: ADVANCED CONDITIONS -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-conditions-section">
                        <div class="vecthare-section-header">
                            <h4>⚡ Advanced Conditions <span class="vecthare-badge-secondary">Secondary</span></h4>
                            <small>Complex rule-based activation (evaluated if triggers don't match or are empty)</small>
                        </div>

                        <!-- Enable toggle -->
                        <div class="vecthare-conditions-toggle">
                            <label class="vecthare-checkbox-label">
                                <input type="checkbox" id="vecthare_conditions_enabled">
                                Enable advanced conditions
                            </label>
                        </div>

                        <!-- Logic selector -->
                        <div class="vecthare-conditions-logic">
                            <label>Condition logic:</label>
                            <select id="vecthare_conditions_logic">
                                <option value="AND">ALL conditions must match (AND)</option>
                                <option value="OR">ANY condition can match (OR)</option>
                            </select>
                        </div>

                        <!-- Rules list -->
                        <div class="vecthare-conditions-rules">
                            <div class="vecthare-conditions-rules-header">
                                <span>Conditions</span>
                                <button class="vecthare-btn-sm" id="vecthare_add_condition">+ Add</button>
                            </div>
                            <div id="vecthare_conditions_list"></div>
                        </div>
                    </div>

                    <!-- ========================================== -->
                    <!-- TEMPORAL DECAY (Per-Collection) -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-decay-section">
                        <div class="vecthare-section-header">
                            <h4>⏳ Temporal Weighting</h4>
                            <small>Adjust chunk relevance based on message age</small>
                        </div>

                        <div class="vecthare-decay-settings">
                            <div class="vecthare-option-row">
                                <label class="vecthare-checkbox-label">
                                    <input type="checkbox" id="vecthare_decay_enabled">
                                    <strong>Enable temporal weighting</strong>
                                </label>
                            </div>

                            <div class="vecthare-decay-advanced" id="vecthare_decay_advanced">
                                <div class="vecthare-type-toggle">
                                    <label class="vecthare-type-option" data-type="decay">
                                        <input type="radio" name="vecthare_decay_type" value="decay" checked>
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📉</span>
                                                <strong>Decay</strong>
                                            </div>
                                            <small>Recent messages score higher. Older memories fade over time.</small>
                                        </div>
                                    </label>
                                    <label class="vecthare-type-option" data-type="nostalgia">
                                        <input type="radio" name="vecthare_decay_type" value="nostalgia">
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📈</span>
                                                <strong>Nostalgia</strong>
                                            </div>
                                            <small>Older messages score higher. Ancient history becomes more relevant.</small>
                                        </div>
                                    </label>
                                </div>

                                <div class="vecthare-curve-label">Curve</div>
                                <div class="vecthare-type-toggle vecthare-curve-toggle">
                                    <label class="vecthare-type-option" data-mode="exponential">
                                        <input type="radio" name="vecthare_decay_mode" value="exponential" checked>
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📐</span>
                                                <strong>Exponential</strong>
                                            </div>
                                            <small>Smooth half-life curve. Effect halves every N messages. Natural decay pattern.</small>
                                        </div>
                                    </label>
                                    <label class="vecthare-type-option" data-mode="linear">
                                        <input type="radio" name="vecthare_decay_mode" value="linear">
                                        <div class="vecthare-type-card">
                                            <div class="vecthare-type-header">
                                                <span class="vecthare-type-icon">📏</span>
                                                <strong>Linear</strong>
                                            </div>
                                            <small>Fixed rate per message. Predictable, steady change. Hits limits faster.</small>
                                        </div>
                                    </label>
                                </div>

                                <div class="vecthare-option-row vecthare-decay-exponential">
                                    <label>Half-life:</label>
                                    <input type="number" id="vecthare_decay_halflife" min="1" max="500" value="50">
                                    <small id="vecthare_halflife_hint">messages until 50% effect</small>
                                </div>

                                <div class="vecthare-option-row vecthare-decay-linear" style="display: none;">
                                    <label>Rate:</label>
                                    <input type="number" id="vecthare_decay_rate" min="0.001" max="0.5" step="0.001" value="0.01">
                                    <small>per message (0.01 = 1%)</small>
                                </div>

                                <div class="vecthare-option-row vecthare-decay-floor">
                                    <label id="vecthare_limit_label">Min relevance:</label>
                                    <input type="number" id="vecthare_decay_min" min="0" max="2" step="0.05" value="0.3">
                                    <small id="vecthare_limit_hint">floor for decay (0-1)</small>
                                </div>

                                <div class="vecthare-option-row vecthare-nostalgia-ceiling" style="display: none;">
                                    <label>Max boost:</label>
                                    <input type="number" id="vecthare_decay_max_boost" min="1" max="3" step="0.1" value="1.2">
                                    <small>ceiling for nostalgia (1.2 = 20% max boost)</small>
                                </div>

                                <div class="vecthare-option-row">
                                    <label class="vecthare-checkbox-label">
                                        <input type="checkbox" id="vecthare_decay_scene_aware">
                                        Scene-aware
                                    </label>
                                    <small>Reset weighting at scene boundaries</small>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- ========================================== -->
                    <!-- PROMPT CONTEXT -->
                    <!-- ========================================== -->
                    <div class="vecthare-activation-section vecthare-context-section">
                        <div class="vecthare-section-header">
                            <h4>💬 Prompt Context</h4>
                            <small>Add context prompts to help the AI understand chunks from this collection</small>
                        </div>

                        <div class="vecthare-context-settings">
                            <div class="vecthare-option-row">
                                <label>Context prompt:</label>
                                <textarea id="vecthare_collection_context"
                                          placeholder="e.g., Things {{char}} remembers about {{user}}:"
                                          rows="2"></textarea>
                                <small>Shown before this collection's chunks. Supports {{user}} and {{char}}.</small>
                            </div>

                            <div class="vecthare-option-row">
                                <label>XML tag (optional):</label>
                                <input type="text" id="vecthare_collection_xml_tag" placeholder="e.g., memories">
                                <small>Wraps this collection's chunks in &lt;tag&gt;...&lt;/tag&gt;</small>
                            </div>

                            <div class="vecthare-option-row vecthare-injection-row">
                                <label>Injection position:</label>
                                <select id="vecthare_collection_position">
                                    <option value="">Use global default</option>
                                    <option value="2">Before Main Prompt</option>
                                    <option value="0">After Main Prompt</option>
                                    <option value="1">In-Chat @ Depth</option>
                                </select>
                                <small>Where this collection's chunks appear in the prompt</small>
                            </div>

                            <div class="vecthare-option-row vecthare-depth-row" id="vecthare_collection_depth_row" style="display: none;">
                                <label>Injection depth: <span id="vecthare_collection_depth_value">2</span></label>
                                <input type="range" id="vecthare_collection_depth" min="0" max="50" step="1" value="2">
                                <small>Messages from end of chat to insert at</small>
                            </div>
                        </div>
                    </div>

                    <!-- Activation Priority Info -->
                    <div class="vecthare-activation-info">
                        <strong>Activation Priority:</strong>
                        <ol>
                            <li><strong>Always Active</strong> → Collection always queries</li>
                            <li><strong>Force in Current Chat</strong> → Queries in this chat without triggers</li>
                            <li><strong>Strict Locks</strong> → Can restrict collection to locked chats/characters only</li>
                            <li><strong>Triggers</strong> → Match keywords in recent messages</li>
                            <li><strong>Advanced Conditions</strong> → Evaluated if triggers empty/don't match</li>
                            <li><strong>No config</strong> → Inactive unless forced, locked, or Always Active</li>
                        </ol>
                    </div>
                </div>

                <div class="vecthare-modal-footer">
                    <button class="vecthare-btn" id="vecthare_activation_cancel">Cancel</button>
                    <button class="vecthare-btn vecthare-btn-primary" id="vecthare_activation_save">Save</button>
                </div>
            </div>
        </div>
    `;

  $("body").append(modalHtml);
  bindActivationEditorEvents();
}

/**
 * Updates hint text based on decay vs nostalgia mode
 * @param {boolean} isNostalgia True if nostalgia mode
 */
function updateTemporalWeightingHints(isNostalgia) {
  if (isNostalgia) {
    $("#vecthare_decay_type_hint").text("Older messages score higher");
    $("#vecthare_halflife_hint").text("messages until 50% of max boost");
  } else {
    $("#vecthare_decay_type_hint").text("Newer messages score higher");
    $("#vecthare_halflife_hint").text("messages until 50% relevance");
  }
}

/**
 * Binds event handlers for activation editor
 */
function bindActivationEditorEvents() {
  $("#vecthare_activation_close, #vecthare_activation_cancel").on(
    "click",
    function (e) {
      e.preventDefault();
      e.stopPropagation();
      closeActivationEditor();
    },
  );

  $("#vecthare_activation_save").on("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    saveActivation();
  });

  $("#vecthare_add_condition").on("click", function (e) {
    e.preventDefault();
    e.stopPropagation();
    addConditionRule();
  });

  // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
  $("#vecthare_activation_editor_modal").on("mousedown touchstart", function (e) {
    e.stopPropagation();
  });

  // Close on background click
  $("#vecthare_activation_editor_modal").on("click", function (e) {
    if (e.target === this) closeActivationEditor();
  });

  // Always active disables other sections
  $("#vecthare_always_active").on("change", function (e) {
    e.stopPropagation();
    const isAlwaysActive = $(this).prop("checked");
    $(".vecthare-triggers-section, .vecthare-conditions-section").toggleClass(
      "vecthare-disabled",
      isAlwaysActive,
    );
  });

  // Decay enabled toggle shows/hides advanced settings
  $("#vecthare_decay_enabled").on("change", function (e) {
    e.stopPropagation();
    const enabled = $(this).prop("checked");
    $("#vecthare_decay_advanced").toggle(enabled);
  });

  // Decay mode toggle shows/hides exponential vs linear settings
  $('input[name="vecthare_decay_mode"]').on("change", function (e) {
    e.stopPropagation();
    const mode = $(this).val();
    $(".vecthare-decay-exponential").toggle(mode === "exponential");
    $(".vecthare-decay-linear").toggle(mode === "linear");
    // Update visual selection state
    $(".vecthare-curve-toggle .vecthare-type-option").removeClass("selected");
    $(this).closest(".vecthare-type-option").addClass("selected");
  });

  // Decay type toggle shows/hides decay-specific vs nostalgia-specific fields
  $('input[name="vecthare_decay_type"]').on("change", function (e) {
    e.stopPropagation();
    const isNostalgia = $(this).val() === "nostalgia";
    $(".vecthare-decay-floor").toggle(!isNostalgia);
    $(".vecthare-nostalgia-ceiling").toggle(isNostalgia);
    updateTemporalWeightingHints(isNostalgia);
    // Update visual selection state
    $(".vecthare-type-option").removeClass("selected");
    $(this).closest(".vecthare-type-option").addClass("selected");
  });

  // Activation editor: Lock-to-chat button - opens dialog to manage multiple locks
  $("#vecthare_activation_lock_collection").off("click").on("click", async function (e) {
    e.stopPropagation();
    const collId = activationEditorState.collectionId;

    if (!collId) {
      toastr.warning("No collection selected");
      return;
    }

    try {
      openCollectionLockDialog(collId);
    } catch (err) {
      console.error("VectHare: Failed to open lock dialog", err);
      toastr.error("Failed to open lock dialog");
    }
  });

  // Refresh lock button when chat changes
  eventSource.on(event_types.CHAT_CHANGED, () => {
    refreshActivationLockButton();
  });

  // Injection position toggle shows/hides depth row
  $("#vecthare_collection_position").on("change", function (e) {
    e.stopPropagation();
    const position = $(this).val();
    // Show depth row only if "In-Chat @ Depth" (value 1) is selected
    $("#vecthare_collection_depth_row").toggle(position === "1");
  });

  // Injection depth slider updates label
  $("#vecthare_collection_depth").on("input", function (e) {
    e.stopPropagation();
    $("#vecthare_collection_depth_value").text($(this).val());
  });
}

/**
 * Renders the activation editor content
 */
function renderActivationEditor() {
  const state = activationEditorState;

  $("#vecthare_activation_collection_name").text(state.collectionName);
  $("#vecthare_always_active").prop("checked", state.alwaysActive);
  $("#vecthare_lock_mode").val(state.lockMode || "prefer");
  $("#vecthare_force_current_chat").prop("checked", state.selectedForCurrentChat || false);
  $("#vecthare_chat_collection_policy").val(state.chatPolicy?.mode || "normal");
  $("#vecthare_exclusive_when_active").prop("checked", state.exclusiveWhenActive || false);
  $("#vecthare_exclusive_scope").val(state.exclusiveScope || "lorebook");

  // Triggers
  const triggersText = state.triggers.join("\n");
  $("#vecthare_triggers_input").val(triggersText);
  $("#vecthare_trigger_match_mode").val(state.triggerMatchMode);
  $("#vecthare_trigger_scan_depth").val(state.triggerScanDepth);
  $("#vecthare_trigger_case_sensitive").prop(
    "checked",
    state.triggerCaseSensitive,
  );

  // Conditions
  $("#vecthare_conditions_enabled").prop("checked", state.conditions.enabled);
  $("#vecthare_conditions_logic").val(state.conditions.logic || "AND");

  // Temporal Weighting (decay or nostalgia)
  const decay = state.temporalDecay;
  $("#vecthare_decay_enabled").prop("checked", decay.enabled);
  const decayType = decay.type || "decay";
  $(`input[name="vecthare_decay_type"][value="${decayType}"]`).prop(
    "checked",
    true,
  );
  $(".vecthare-type-option").removeClass("selected");
  $(`.vecthare-type-option[data-type="${decayType}"]`).addClass("selected");
  const decayMode = decay.mode || "exponential";
  $(`input[name="vecthare_decay_mode"][value="${decayMode}"]`).prop(
    "checked",
    true,
  );
  $(`.vecthare-type-option[data-mode="${decayMode}"]`).addClass("selected");
  $("#vecthare_decay_halflife").val(decay.halfLife);
  $("#vecthare_decay_rate").val(decay.linearRate);
  $("#vecthare_decay_min").val(decay.minRelevance);
  $("#vecthare_decay_max_boost").val(decay.maxBoost || 1.2);
  $("#vecthare_decay_scene_aware").prop("checked", decay.sceneAware);

  // Show/hide advanced decay settings based on enabled
  $("#vecthare_decay_advanced").toggle(decay.enabled);

  // Show correct decay mode fields
  $(".vecthare-decay-exponential").toggle(decay.mode === "exponential");
  $(".vecthare-decay-linear").toggle(decay.mode === "linear");

  // Show/hide type-specific fields and update hints
  const isNostalgia = decayType === "nostalgia";
  $(".vecthare-decay-floor").toggle(!isNostalgia);
  $(".vecthare-nostalgia-ceiling").toggle(isNostalgia);
  updateTemporalWeightingHints(isNostalgia);

  // Prompt Context
  $("#vecthare_collection_context").val(state.context || "");
  $("#vecthare_collection_xml_tag").val(state.xmlTag || "");

  // Injection position/depth
  const posValue = state.position !== null ? String(state.position) : "";
  $("#vecthare_collection_position").val(posValue);
  $("#vecthare_collection_depth").val(state.depth ?? 2);
  $("#vecthare_collection_depth_value").text(state.depth ?? 2);
  // Show depth row only if position is "In-Chat @ Depth" (value 1)
  $("#vecthare_collection_depth_row").toggle(state.position === 1);

  // Disable sections if always active
  const isAlwaysActive = state.alwaysActive;
  $(".vecthare-triggers-section, .vecthare-conditions-section").toggleClass(
    "vecthare-disabled",
    isAlwaysActive,
  );

  // Refresh lock button state for this collection
  refreshActivationLockButton();

  renderConditionRules();
}

/**
 * Refresh the lock button in the activation editor based on current collection and chat
 */
function refreshActivationLockButton() {
  try {
    const collId = activationEditorState.collectionId;
    const $btn = $("#vecthare_activation_lock_collection");
    const chatId = getCurrentChatId();
    const context = getContext();
    const charId = context?.characterId || null;

    if (!$btn || $btn.length === 0) return;

    if (!collId) {
      $btn.prop("disabled", true).text("🔒 Lock to Chat");
      $btn.attr("title", "No collection selected");
      return;
    }

    const chatLockCount = getCollectionLockCount(collId);
    const charLockCount = getCollectionCharacterLockCount(collId);
    const isLockedToCurrentChat = chatId && isCollectionLockedToChat(collId, chatId);
    const isLockedToCurrentChar = charId && isCollectionLockedToCharacter(collId, charId);
    const totalLocks = chatLockCount + charLockCount;

    if (totalLocks === 0) {
      $btn.prop("disabled", false).text("🔒 Manage Locks");
      $btn.attr("title", "No locks set. Click to add locks");
    } else {
      const lockedStatus = (isLockedToCurrentChat || isLockedToCurrentChar) ? "🔓" : "🔒";
      $btn.prop("disabled", false).text(`${lockedStatus} ${totalLocks} lock${totalLocks !== 1 ? "s" : ""}`);

      let tooltip = `Collection has ${totalLocks} lock${totalLocks !== 1 ? "s" : ""}`;
      if (chatLockCount > 0) tooltip += ` (${chatLockCount} chat${chatLockCount !== 1 ? "s" : ""})`;
      if (charLockCount > 0) tooltip += ` (${charLockCount} character${charLockCount !== 1 ? "s" : ""})`;
      if (isLockedToCurrentChat || isLockedToCurrentChar) tooltip += " - ACTIVE for current context";

      $btn.attr("title", tooltip);
    }
  } catch (err) {
    console.error("VectHare: Failed to refresh activation lock button", err);
  }
}

/**
 * Saves collection settings (activation + triggers + conditions + decay)
 */
function saveActivation() {
  const state = activationEditorState;

  // Parse triggers from textarea
  const triggersRaw = $("#vecthare_triggers_input").val();
  const triggers = triggersRaw
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  // Build temporal weighting settings (decay or nostalgia)
  const temporalDecay = {
    enabled: $("#vecthare_decay_enabled").prop("checked"),
    type: $('input[name="vecthare_decay_type"]:checked').val() || "decay",
    mode: $('input[name="vecthare_decay_mode"]:checked').val() || "exponential",
    halfLife: parseInt($("#vecthare_decay_halflife").val()) || 50,
    linearRate: parseFloat($("#vecthare_decay_rate").val()) || 0.01,
    minRelevance: parseFloat($("#vecthare_decay_min").val()) || 0.3,
    maxBoost: parseFloat($("#vecthare_decay_max_boost").val()) || 1.2,
    sceneAware: $("#vecthare_decay_scene_aware").prop("checked"),
  };

  // Get prompt context values (sanitize xml tag)
  const contextPrompt = $("#vecthare_collection_context").val() || "";
  const xmlTagRaw = $("#vecthare_collection_xml_tag").val() || "";
  const xmlTag = xmlTagRaw.replace(/[^a-zA-Z0-9_-]/g, "");

  // Get injection position/depth (empty string = use global default = null)
  const positionRaw = $("#vecthare_collection_position").val();
  const position = positionRaw === "" ? null : parseInt(positionRaw);
  const depth =
    position === 1
      ? parseInt($("#vecthare_collection_depth").val()) || 2
      : null;

  // Update metadata (all in one call)
  setCollectionMeta(state.collectionId, {
    alwaysActive: $("#vecthare_always_active").prop("checked"),
    lockMode: $("#vecthare_lock_mode").val() || "prefer",
    exclusiveWhenActive: $("#vecthare_exclusive_when_active").prop("checked"),
    exclusiveScope: $("#vecthare_exclusive_scope").val() || "lorebook",
    triggers: triggers,
    triggerMatchMode: $("#vecthare_trigger_match_mode").val(),
    triggerScanDepth: parseInt($("#vecthare_trigger_scan_depth").val()) || 5,
    triggerCaseSensitive: $("#vecthare_trigger_case_sensitive").prop("checked"),
    temporalDecay: temporalDecay,
    context: contextPrompt,
    xmlTag: xmlTag,
    position: position,
    depth: depth,
  });

  // Save conditions
  const conditions = {
    enabled: $("#vecthare_conditions_enabled").prop("checked"),
    logic: $("#vecthare_conditions_logic").val(),
    rules: state.conditions.rules || [],
  };
  setCollectionConditions(state.collectionId, conditions);

  const currentChatId = getCurrentChatId();
  if (currentChatId) {
    const policy = getChatCollectionPolicy(currentChatId);
    setChatCollectionPolicy(currentChatId, {
      ...policy,
      mode: $("#vecthare_chat_collection_policy").val() || "normal",
    });

    if ($("#vecthare_force_current_chat").prop("checked")) {
      addCollectionToChatPolicy(currentChatId, state.collectionId);
    } else {
      removeCollectionFromChatPolicy(currentChatId, state.collectionId);
    }
  }

  closeActivationEditor();
  refreshCollections();
  toastr.success("Collection settings saved", "VectHare");
}

/**
 * Renders the list of condition rules
 */
function renderConditionRules() {
  const rules = activationEditorState.conditions.rules || [];
  const container = $("#vecthare_conditions_list");

  if (rules.length === 0) {
    container.html(
      '<div class="vecthare-empty-rules">No conditions yet. Click "+ Add Condition" to add one.</div>',
    );
    return;
  }

  const rulesHtml = rules
    .map((rule, idx) => renderConditionRule(rule, idx))
    .join("");
  container.html(rulesHtml);

  // Bind rule events
  bindConditionRuleEvents();
}

/**
 * Renders a single condition rule
 */
function renderConditionRule(rule, index) {
  const typeOptions = CONDITION_TYPES.map(
    (t) =>
      `<option value="${t.value}" ${rule.type === t.value ? "selected" : ""}>${t.label}</option>`,
  ).join("");

  return `
        <div class="vecthare-condition-rule" data-rule-index="${index}">
            <div class="vecthare-condition-row">
                <select class="vecthare-condition-type" data-rule-index="${index}">
                    ${typeOptions}
                </select>
                <label class="vecthare-condition-negate">
                    <input type="checkbox" ${rule.negate ? "checked" : ""} data-rule-index="${index}">
                    NOT
                </label>
                <button class="vecthare-btn-icon vecthare-condition-remove" data-rule-index="${index}">🗑️</button>
            </div>
            <div class="vecthare-condition-settings" data-rule-index="${index}">
                ${renderConditionSettings(rule, index)}
            </div>
        </div>
    `;
}

/**
 * Renders settings for a specific condition type
 */
function renderConditionSettings(rule, index) {
  const settings = rule.settings || {};

  switch (rule.type) {
    case "keyword": // Legacy support
    case "pattern":
      return `
                <div class="vecthare-pattern-condition-wrapper">
                    <div class="vecthare-pattern-row">
                        <textarea class="vecthare-pattern-input" placeholder="Patterns (one per line)&#10;Plain text or regex: /pattern/i"
                                  data-field="patterns" data-rule-index="${index}"
                                  rows="3">${(settings.patterns || settings.values || []).join("\n")}</textarea>
                    </div>
                    <div class="vecthare-pattern-options">
                        <div class="vecthare-option-row">
                            <label>Match mode:</label>
                            <select data-field="matchMode" data-rule-index="${index}">
                                <option value="any" ${settings.matchMode === "any" ? "selected" : ""}>ANY pattern matches</option>
                                <option value="all" ${settings.matchMode === "all" ? "selected" : ""}>ALL patterns must match</option>
                            </select>
                        </div>
                        <div class="vecthare-option-row">
                            <label>Scan depth:</label>
                            <input type="number" data-field="scanDepth" data-rule-index="${index}"
                                   min="1" max="100" value="${settings.scanDepth || 10}">
                            <small>messages</small>
                        </div>
                        <div class="vecthare-option-row">
                            <label>Search in:</label>
                            <select data-field="searchIn" data-rule-index="${index}">
                                <option value="all" ${settings.searchIn === "all" ? "selected" : ""}>All messages</option>
                                <option value="user" ${settings.searchIn === "user" ? "selected" : ""}>User only</option>
                                <option value="assistant" ${settings.searchIn === "assistant" ? "selected" : ""}>Assistant only</option>
                            </select>
                        </div>
                        <div class="vecthare-option-row">
                            <label class="vecthare-checkbox-label">
                                <input type="checkbox" data-field="caseSensitive" data-rule-index="${index}"
                                       ${settings.caseSensitive ? "checked" : ""}>
                                Case sensitive
                            </label>
                        </div>
                    </div>
                </div>
            `;

    case "speaker":
    case "characterPresent":
      return `
                <input type="text" placeholder="Character names (comma-separated)"
                       value="${(settings.values || []).join(", ")}"
                       data-field="values" data-rule-index="${index}">
                <select data-field="matchType" data-rule-index="${index}">
                    <option value="any" ${settings.matchType === "any" ? "selected" : ""}>Any matches</option>
                    <option value="all" ${settings.matchType === "all" ? "selected" : ""}>All must match</option>
                </select>
            `;

    case "messageCount":
    case "swipeCount":
      return `
                <input type="number" placeholder="Count" min="0"
                       value="${settings.count || 0}"
                       data-field="count" data-rule-index="${index}">
                <select data-field="operator" data-rule-index="${index}">
                    <option value="eq" ${settings.operator === "eq" ? "selected" : ""}>Exactly</option>
                    <option value="gte" ${settings.operator === "gte" ? "selected" : ""}>At least</option>
                    <option value="lte" ${settings.operator === "lte" ? "selected" : ""}>At most</option>
                </select>
            `;

    case "emotion":
      const emotionOptions = VALID_EMOTIONS.map(
        (e) =>
          `<option value="${e}" ${(settings.values || []).includes(e) ? "selected" : ""}>${e}</option>`,
      ).join("");
      const expressionsStatus = getExpressionsExtensionStatus();
      return `
                <div class="vecthare-emotion-condition-wrapper">
                    <div class="vecthare-conditions-notice vecthare-notice-${expressionsStatus.level} vecthare-emotion-notice">
                        ${expressionsStatus.message}
                    </div>
                    <div class="vecthare-emotion-controls">
                        <select multiple data-field="values" data-rule-index="${index}" class="vecthare-multi-select">
                            ${emotionOptions}
                        </select>
                        <select data-field="detectionMethod" data-rule-index="${index}">
                            <option value="auto" ${settings.detectionMethod === "auto" ? "selected" : ""}>Auto (recommended)</option>
                            <option value="expressions" ${settings.detectionMethod === "expressions" ? "selected" : ""}>Expressions only</option>
                            <option value="patterns" ${settings.detectionMethod === "patterns" ? "selected" : ""}>Patterns only</option>
                            <option value="both" ${settings.detectionMethod === "both" ? "selected" : ""}>Both must match</option>
                        </select>
                    </div>
                </div>
            `;

    case "isGroupChat":
      return `
                <select data-field="isGroup" data-rule-index="${index}">
                    <option value="true" ${settings.isGroup === true ? "selected" : ""}>Is group chat</option>
                    <option value="false" ${settings.isGroup === false ? "selected" : ""}>Is 1-on-1 chat</option>
                </select>
            `;

    case "generationType":
      const genOptions = VALID_GENERATION_TYPES.map(
        (g) =>
          `<option value="${g}" ${(settings.values || []).includes(g) ? "selected" : ""}>${g}</option>`,
      ).join("");
      return `
                <select multiple data-field="values" data-rule-index="${index}" class="vecthare-multi-select">
                    ${genOptions}
                </select>
            `;

    case "lorebookActive":
      // Get available world names for the picker
      const availableWorlds = world_names || [];
      const worldOptions = availableWorlds
        .map((w) => `<option value="${escapeHtml(w)}">${escapeHtml(w)}</option>`)
        .join("");
      const selectedValues = settings.values || [];
      return `
                <div class="vecthare-lorebook-picker-wrapper">
                    <div class="vecthare-lorebook-picker-row">
                        <select class="vecthare-lorebook-select" data-rule-index="${index}">
                            <option value="">-- Select Lorebook --</option>
                            ${worldOptions}
                        </select>
                        <select class="vecthare-lorebook-entry-select" data-rule-index="${index}" disabled>
                            <option value="">-- Select Entry (optional) --</option>
                        </select>
                        <button class="vecthare-btn-sm vecthare-lorebook-add" data-rule-index="${index}" type="button">+ Add</button>
                    </div>
                    <div class="vecthare-lorebook-selected" data-rule-index="${index}">
                        ${selectedValues
                          .map(
                            (v) => `
                            <span class="vecthare-lorebook-tag" data-value="${escapeHtml(v)}">
                                ${escapeHtml(v)} <button class="vecthare-lorebook-remove" data-value="${escapeHtml(v)}" data-rule-index="${index}">×</button>
                            </span>
                        `,
                          )
                          .join("")}
                    </div>
                    <input type="hidden" data-field="values" data-rule-index="${index}" value="${selectedValues.join(",")}">
                </div>
            `;

    case "timeOfDay":
      return `
                <input type="time" value="${settings.startTime || "00:00"}"
                       data-field="startTime" data-rule-index="${index}">
                <span>to</span>
                <input type="time" value="${settings.endTime || "23:59"}"
                       data-field="endTime" data-rule-index="${index}">
            `;

    case "randomChance":
      return `
                <input type="number" placeholder="Probability %" min="0" max="100"
                       value="${settings.probability || 50}"
                       data-field="probability" data-rule-index="${index}">
                <span>%</span>
            `;

    default:
      return '<span class="vecthare-unknown-type">Unknown condition type</span>';
  }
}

/**
 * Binds events for individual condition rules
 */
function bindConditionRuleEvents() {
  // Type change
  $(".vecthare-condition-type")
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules[idx].type = $(this).val();
      activationEditorState.conditions.rules[idx].settings = {};
      renderConditionRules();
    });

  // Negate toggle
  $(".vecthare-condition-negate input")
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules[idx].negate =
        $(this).prop("checked");
    });

  // Remove rule
  $(".vecthare-condition-remove")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      activationEditorState.conditions.rules.splice(idx, 1);
      renderConditionRules();
    });

  // Settings fields (inputs, selects, and textareas)
  $(
    ".vecthare-condition-settings input, .vecthare-condition-settings select, .vecthare-condition-settings textarea",
  )
    .off("change")
    .on("change", function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const field = $(this).data("field");
      let value = $(this).val();

      // Handle patterns (textarea, newline-separated)
      if (field === "patterns" && typeof value === "string") {
        value = value
          .split("\n")
          .map((v) => v.trim())
          .filter((v) => v);
      }

      // Handle comma-separated values
      if (field === "values" && typeof value === "string") {
        value = value
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v);
      }

      // Handle multi-select
      if ($(this).prop("multiple")) {
        value = $(this).val() || [];
      }

      // Handle checkboxes
      if ($(this).attr("type") === "checkbox") {
        value = $(this).prop("checked");
      }

      // Handle booleans from select
      if (field === "isGroup") {
        value = value === "true";
      }

      // Handle numbers
      if (["count", "probability", "scanDepth"].includes(field)) {
        value = parseInt(value) || 0;
      }

      if (!activationEditorState.conditions.rules[idx].settings) {
        activationEditorState.conditions.rules[idx].settings = {};
      }
      activationEditorState.conditions.rules[idx].settings[field] = value;
    });

  // Lorebook picker: world select change - load entries
  $(".vecthare-lorebook-select")
    .off("change")
    .on("change", async function (e) {
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const worldName = $(this).val();
      const entrySelect = $(
        `.vecthare-lorebook-entry-select[data-rule-index="${idx}"]`,
      );

      if (!worldName) {
        entrySelect
          .prop("disabled", true)
          .html('<option value="">-- Select Entry (optional) --</option>');
        return;
      }

      // Load world info entries
      entrySelect
        .prop("disabled", true)
        .html('<option value="">Loading...</option>');
      try {
        const worldData = await loadWorldInfo(worldName);
        if (worldData && worldData.entries) {
          const entries = Object.values(worldData.entries);
          const entryOptions = entries
            .map((entry) => {
              const displayName =
                entry.comment || entry.key?.join(", ") || `Entry ${entry.uid}`;
              return `<option value="${escapeHtml(entry.uid)}" data-key="${escapeHtml(entry.key?.join(",") || "")}">${escapeHtml(displayName)}</option>`;
            })
            .join("");
          entrySelect.html(
            `<option value="">-- Entire Lorebook --</option>${entryOptions}`,
          );
          entrySelect.prop("disabled", false);
        }
      } catch (error) {
        console.error("VectHare: Failed to load world info", error);
        entrySelect.html(
          '<option value="">-- Error loading entries --</option>',
        );
      }
    });

  // Lorebook picker: add button
  $(".vecthare-lorebook-add")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const worldSelect = $(
        `.vecthare-lorebook-select[data-rule-index="${idx}"]`,
      );
      const entrySelect = $(
        `.vecthare-lorebook-entry-select[data-rule-index="${idx}"]`,
      );
      const selectedContainer = $(
        `.vecthare-lorebook-selected[data-rule-index="${idx}"]`,
      );
      const hiddenInput = $(
        `input[data-field="values"][data-rule-index="${idx}"]`,
      );

      const worldName = worldSelect.val();
      if (!worldName) {
        toastr.warning("Please select a lorebook first", "VectHare");
        return;
      }

      const entryUid = entrySelect.val();
      let valueToAdd;

      if (entryUid) {
        // Specific entry: use "worldName:uid" format
        valueToAdd = `${worldName}:${entryUid}`;
      } else {
        // Entire lorebook
        valueToAdd = worldName;
      }

      // Get current values
      const currentValues = hiddenInput.val()
        ? hiddenInput
            .val()
            .split(",")
            .filter((v) => v)
        : [];
      if (currentValues.includes(valueToAdd)) {
        toastr.info("Already added", "VectHare");
        return;
      }

      currentValues.push(valueToAdd);
      hiddenInput.val(currentValues.join(","));

      // Update the visual tags
      const displayName = entryUid
        ? `${worldName}:${entrySelect.find(":selected").text()}`
        : worldName;
      selectedContainer.append(`
            <span class="vecthare-lorebook-tag" data-value="${escapeHtml(valueToAdd)}">
                ${escapeHtml(displayName)} <button class="vecthare-lorebook-remove" data-value="${escapeHtml(valueToAdd)}" data-rule-index="${idx}">×</button>
            </span>
        `);

      // Update state
      if (!activationEditorState.conditions.rules[idx].settings) {
        activationEditorState.conditions.rules[idx].settings = {};
      }
      activationEditorState.conditions.rules[idx].settings.values =
        currentValues;

      // Rebind remove buttons
      bindLorebookRemoveButtons();

      // Reset selects
      worldSelect.val("");
      entrySelect
        .prop("disabled", true)
        .html('<option value="">-- Select Entry (optional) --</option>');
    });

  // Bind remove buttons
  bindLorebookRemoveButtons();
}

/**
 * Binds lorebook tag remove buttons
 */
function bindLorebookRemoveButtons() {
  $(".vecthare-lorebook-remove")
    .off("click")
    .on("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      const idx = $(this).data("rule-index");
      const valueToRemove = $(this).data("value");
      const hiddenInput = $(
        `input[data-field="values"][data-rule-index="${idx}"]`,
      );

      // Remove from values
      const currentValues = hiddenInput.val()
        ? hiddenInput
            .val()
            .split(",")
            .filter((v) => v && v !== valueToRemove)
        : [];
      hiddenInput.val(currentValues.join(","));

      // Update state
      if (activationEditorState.conditions.rules[idx]?.settings) {
        activationEditorState.conditions.rules[idx].settings.values =
          currentValues;
      }

      // Remove the tag
      $(this).closest(".vecthare-lorebook-tag").remove();
    });
}

/**
 * Adds a new condition rule
 */
function addConditionRule() {
  if (!activationEditorState.conditions.rules) {
    activationEditorState.conditions.rules = [];
  }

  activationEditorState.conditions.rules.push({
    type: "pattern",
    negate: false,
    settings: {},
  });

  renderConditionRules();
}

// ============================================================================
// COLLECTION LOCK MANAGEMENT DIALOG
// ============================================================================

/**
 * Opens a dialog to manage locks for a collection (add/remove multiple chats)
 * @param {string} collectionId
 */
function openCollectionLockDialog(collectionId) {
    const locks = getCollectionLocks(collectionId);
    const characterLocks = getCollectionCharacterLocks(collectionId);
    const currentChatId = getCurrentChatId();
    const context = getContext();
    const currentCharacterId = context?.characterId || null;
    const characters = context?.characters || [];

    // Build HTML for locked chats
    const locksHtml = locks.length === 0
        ? '<div class="vecthare-lock-list-empty">No chats locked yet</div>'
        : locks.map((chatId) => `
            <div class="vecthare-lock-item" data-chat-id="${escapeHtml(chatId)}">
                <span class="vecthare-lock-chat-id" title="${escapeHtml(chatId)}">${escapeHtml(chatId)}</span>
                <div class="vecthare-lock-item-actions">
                    ${String(chatId) === String(currentChatId) ? '<span class="vecthare-lock-badge-current">Current</span>' : ''}
                    <button class="vecthare-lock-remove-btn" data-chat-id="${escapeHtml(chatId)}" title="Remove lock">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </div>
        `).join('');

    // Build HTML for locked characters
    const charLocksHtml = characterLocks.length === 0
        ? '<div class="vecthare-lock-list-empty">No characters locked yet</div>'
        : characterLocks.map((charId) => {
            const charName = characters[charId]?.data?.name || `Character ${charId}`;
            return `
                <div class="vecthare-lock-item" data-character-id="${charId}">
                    <span class="vecthare-lock-character-name">
                        <i class="fa-solid fa-user"></i>
                        ${escapeHtml(charName)}
                    </span>
                    <div class="vecthare-lock-item-actions">
                        ${String(charId) === String(currentCharacterId) ? '<span class="vecthare-lock-badge-current">Active</span>' : ''}
                        <button class="vecthare-lock-remove-char-btn" data-character-id="${charId}" title="Remove lock">
                            <i class="fa-solid fa-trash"></i>
                        </button>
                    </div>
                </div>
            `;
        }).join('');

    // Generate hint text for chat section
    const chatHintClass = currentChatId && locks.includes(currentChatId) ? 'vecthare-lock-hint vecthare-lock-hint-success' : 'vecthare-lock-hint';
    const chatHintText = currentChatId
        ? locks.includes(currentChatId)
            ? '✓ Already locked to this chat'
            : 'Lock this collection to the current chat'
        : 'Open a chat first to lock this collection';

    // Generate hint text for character section
    const charHintClass = currentCharacterId && characterLocks.includes(currentCharacterId) ? 'vecthare-lock-hint vecthare-lock-hint-success' : 'vecthare-lock-hint';
    const charHintText = currentCharacterId
        ? characterLocks.includes(currentCharacterId)
            ? '✓ Already locked to this character'
            : 'Lock this collection to the current character'
        : 'No character currently active';

    const dialogHtml = `
        <div id="vecthare_lock_dialog" class="vecthare-modal" style="display: flex;">
            <div class="vecthare-modal-content vecthare-lock-dialog">
                <div class="vecthare-modal-header">
                    <h3><i class="fa-solid fa-lock"></i> Manage Collection Locks</h3>
                    <button class="vecthare-modal-close" data-action="close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-modal-body">
                    <!-- Chat Locks Section -->
                    <div class="vecthare-lock-section">
                        <h4><i class="fa-solid fa-comments"></i> Chat Locks <span class="vecthare-badge vecthare-badge-muted">${locks.length}</span></h4>
                        <div class="vecthare-lock-list">
                            ${locksHtml}
                        </div>
                        <p class="${chatHintClass}">${chatHintText}</p>
                        <button id="vecthare_lock_add_current" class="vecthare-btn-sm vecthare-btn-primary" ${!currentChatId || locks.includes(currentChatId) ? 'disabled' : ''}>
                            <i class="fa-solid fa-plus"></i> Lock to Current Chat
                        </button>
                    </div>

                    <hr class="vecthare-lock-divider">

                    <!-- Character Locks Section -->
                    <div class="vecthare-lock-section">
                        <h4><i class="fa-solid fa-user"></i> Character Locks <span class="vecthare-badge vecthare-badge-muted">${characterLocks.length}</span></h4>
                        <div class="vecthare-lock-list">
                            ${charLocksHtml}
                        </div>
                        <p class="${charHintClass}">${charHintText}</p>
                        <button id="vecthare_lock_add_character" class="vecthare-btn-sm vecthare-btn-primary" ${!currentCharacterId || characterLocks.includes(currentCharacterId) ? 'disabled' : ''}>
                            <i class="fa-solid fa-plus"></i> Lock to Current Character
                        </button>
                    </div>
                </div>
                <div class="vecthare-modal-footer">
                    <button class="vecthare-btn" data-action="close">
                        <i class="fa-solid fa-check"></i> Done
                    </button>
                </div>
            </div>
        </div>
    `;

    const $dialog = $(dialogHtml);
    $('body').append($dialog);

    // Handle add lock button (chat)
    $('#vecthare_lock_add_current').on('click', function() {
        const chatId = getCurrentChatId();
        if (!chatId) {
            toastr.warning('Open a chat first');
            return;
        }

        setCollectionLock(collectionId, chatId);
        toastr.success('Collection locked to current chat', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle add lock button (character)
    $('#vecthare_lock_add_character').on('click', function() {
        const context = getContext();
        const charId = context?.characterId;
        if (!charId) {
            toastr.warning('No character currently active');
            return;
        }

        setCollectionCharacterLock(collectionId, charId);
        toastr.success('Collection locked to current character', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle remove lock buttons (chat)
    $dialog.find('.vecthare-lock-remove-btn').on('click', function(e) {
        e.stopPropagation();
        const chatId = $(this).data('chat-id');

        removeCollectionLock(collectionId, chatId);
        toastr.info('Removed lock from chat', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle remove lock buttons (character)
    $dialog.find('.vecthare-lock-remove-char-btn').on('click', function(e) {
        e.stopPropagation();
        const charId = $(this).data('character-id');

        removeCollectionCharacterLock(collectionId, charId);
        toastr.info('Removed lock from character', 'VectHare');

        // Re-open dialog with updated state
        $dialog.remove();
        refreshActivationLockButton();
        openCollectionLockDialog(collectionId);
    });

    // Handle close button
    $dialog.find('[data-action="close"]').on('click', function(e) {
        e.preventDefault();
        $dialog.remove();
    });

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    $dialog.on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    // Close on background click
    $dialog.on('click', function(e) {
        if (e.target === this) {
            $dialog.remove();
        }
    });

    // Handle escape key
    $(document).one('keydown.lock_dialog', function(e) {
        if (e.key === 'Escape') {
            $dialog.remove();
        }
    });
}
