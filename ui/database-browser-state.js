/**
 * Shared state for the database browser modules.
 */

// Browser state
export const browserState = {
  isOpen: false,
  pluginAvailable: null,
  collections: [],
  selectedCollection: null,
  filters: {
    scope: "all", // 'all', 'global', 'character', 'chat'
    collectionType: "all", // 'all', 'chat', 'file', 'lorebook'
    searchQuery: "",
  },
  settings: null,
  // Bulk operations state
  bulkSelected: new Set(),
  bulkFilter: "all", // 'all', 'enabled', 'disabled'
  // Search state
  searchResults: null,
  isSearching: false,
  // Keyword filter state
  keywordFilter: '',
  availableKeywords: [],
  // PNG export state
  pendingPngExport: null,
};
