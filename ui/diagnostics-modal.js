/**
 * Diagnostics modal: running checks, showing results, copying the report and applying fixes.
 */

import { extension_settings } from '../../../../extensions.js';
import { getModelField } from '../core/providers.js';
import { pluginRequest } from '../backends/similharity-backend.js';
import { logger } from '../utils/logger.js';

/**
 * Initializes diagnostics modal functionality
 */
export function initializeDiagnosticsModal() {
    // Close button
    $('#vecthare_diagnostics_close').on('click', function() {
        closeDiagnosticsModal();
    });

    // Click overlay to close
    $('#vecthare_diagnostics_modal .vecthare-modal-overlay').on('click', function() {
        closeDiagnosticsModal();
    });

    // Stop mousedown propagation (ST closes drawers on mousedown/touchstart)
    // Note: This modal is inside the drawer so it doesn't strictly need this,
    // but we include it for consistency with other modals
    $('#vecthare_diagnostics_modal').on('mousedown touchstart', function(e) {
        e.stopPropagation();
    });

    // ESC key to close
    $(document).on('keydown', function(e) {
        if (e.key === 'Escape' && $('#vecthare_diagnostics_modal').is(':visible')) {
            closeDiagnosticsModal();
        }
    });

    // Cancel button
    $('#vecthare_diag_cancel').on('click', function() {
        closeDiagnosticsModal();
    });

    // Done button
    $('#vecthare_diag_done').on('click', function() {
        closeDiagnosticsModal();
    });

    // Back button - go back to selection
    $('#vecthare_diag_back').on('click', function() {
        showDiagnosticsPhase('selection');
        $('#vecthare_diagnostics_title').text('Run Diagnostics');
    });

    // Run button - execute diagnostics
    $('#vecthare_diag_run').on('click', async function() {
        await executeDiagnostics();
    });
}

/**
 * Closes the diagnostics modal and resets to selection phase
 */
function closeDiagnosticsModal() {
    $('#vecthare_diagnostics_modal').fadeOut(200, function() {
        // Reset to selection phase for next open
        showDiagnosticsPhase('selection');
        $('#vecthare_diagnostics_title').text('Run Diagnostics');
    });
}

/**
 * Shows a specific phase of the diagnostics modal
 * @param {string} phase - 'selection', 'running', or 'results'
 */
function showDiagnosticsPhase(phase) {
    $('#vecthare_diagnostics_selection').hide();
    $('#vecthare_diagnostics_running').hide();
    $('#vecthare_diagnostics_results').hide();
    $(`#vecthare_diagnostics_${phase}`).show();
}

// Console error capture for diagnostics
let capturedConsoleLogs = [];

let originalConsoleError = null;

let originalConsoleWarn = null;

/**
 * Starts capturing console errors and warnings
 */
function startConsoleCapture() {
    capturedConsoleLogs = [];

    // Store originals
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;

    // Override console.error
    console.error = function(...args) {
        capturedConsoleLogs.push({
            type: 'error',
            message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
            timestamp: new Date().toISOString(),
            stack: new Error().stack
        });
        originalConsoleError.apply(console, args);
    };

    // Override console.warn
    console.warn = function(...args) {
        capturedConsoleLogs.push({
            type: 'warning',
            message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
            timestamp: new Date().toISOString()
        });
        originalConsoleWarn.apply(console, args);
    };
}

/**
 * Stops capturing console errors and returns captured logs
 * @returns {Array} Captured console logs
 */
function stopConsoleCapture() {
    // Restore originals
    if (originalConsoleError) {
        console.error = originalConsoleError;
        originalConsoleError = null;
    }
    if (originalConsoleWarn) {
        console.warn = originalConsoleWarn;
        originalConsoleWarn = null;
    }

    return capturedConsoleLogs;
}

/**
 * Executes diagnostics based on selected categories
 */
async function executeDiagnostics() {
    const settings = extension_settings.vecthare;

    // Get selected categories
    const runInfrastructure = $('#vecthare_diag_infrastructure').prop('checked');
    const runConfiguration = $('#vecthare_diag_configuration').prop('checked');
    const runVisualizer = $('#vecthare_diag_visualizer').prop('checked');
    const runProduction = $('#vecthare_diag_production').prop('checked');

    if (!runInfrastructure && !runConfiguration && !runVisualizer && !runProduction) {
        toastr.warning('Please select at least one category to run');
        return;
    }

    // Show running phase
    showDiagnosticsPhase('running');
    $('#vecthare_diagnostics_title').text('Running Diagnostics...');

    // Start capturing console errors
    startConsoleCapture();

    try {
        // Import and run diagnostics
        const { runDiagnostics } = await import('../diagnostics/index.js');
        const results = await runDiagnostics(settings, runProduction);

        // Stop capturing and get logs
        const consoleLogs = stopConsoleCapture();

        // Filter results based on selected categories
        const filteredResults = {
            version: results.version,
            categories: {},
            checks: [],
            overall: results.overall,
            timestamp: results.timestamp,
            consoleErrors: consoleLogs
        };

        if (runInfrastructure && results.categories.infrastructure) {
            filteredResults.categories.infrastructure = results.categories.infrastructure;
            filteredResults.checks.push(...results.categories.infrastructure);
        }
        if (runConfiguration && results.categories.configuration) {
            filteredResults.categories.configuration = results.categories.configuration;
            filteredResults.checks.push(...results.categories.configuration);
        }
        if (runVisualizer && results.categories.visualizer) {
            filteredResults.categories.visualizer = results.categories.visualizer;
            filteredResults.checks.push(...results.categories.visualizer);
        }
        if (runProduction && results.categories.production) {
            filteredResults.categories.production = results.categories.production;
            filteredResults.checks.push(...results.categories.production);
        }

        // Add console errors as a category if any were captured
        if (consoleLogs.length > 0) {
            filteredResults.categories.console = consoleLogs.map(log => ({
                name: `Console ${log.type}`,
                status: log.type === 'error' ? 'fail' : 'warning',
                message: log.message.substring(0, 200) + (log.message.length > 200 ? '...' : ''),
                category: 'console'
            }));
            filteredResults.checks.push(...filteredResults.categories.console);
        }

        // Recalculate overall status based on filtered results
        const failCount = filteredResults.checks.filter(c => c.status === 'fail').length;
        const warnCount = filteredResults.checks.filter(c => c.status === 'warning').length;
        filteredResults.overall = failCount > 0 ? 'issues' : warnCount > 0 ? 'warnings' : 'healthy';

        // Show results
        showDiagnosticsResults(filteredResults);

    } catch (error) {
        stopConsoleCapture();
        console.error('VectHare Diagnostics error:', error);
        toastr.error('Failed to run diagnostics: ' + error.message);
        showDiagnosticsPhase('selection');
        $('#vecthare_diagnostics_title').text('Run Diagnostics');
    }
}

// Store current diagnostic results for copy/filter functionality
let currentDiagnosticResults = null;
let currentDiagnosticFilter = 'all'; // 'all', 'pass', 'warning', 'fail'

/**
 * Shows diagnostics results in the results phase
 * @param {object} results - Diagnostics results object
 */
export function showDiagnosticsResults(results) {
    // Store results globally for copy/filter functionality
    currentDiagnosticResults = results;
    currentDiagnosticFilter = 'all';

    renderDiagnosticsContent(results, 'all');

    // Show results phase
    showDiagnosticsPhase('results');
}

/**
 * Renders diagnostic content with optional status filter
 * @param {object} results - Diagnostics results object
 * @param {string} filter - Filter: 'all', 'pass', 'warning', 'fail'
 */
function renderDiagnosticsContent(results, filter = 'all') {
    const output = $('#vecthare_diagnostics_content');
    output.empty();

    logger.debug('VectHare UI: Rendering diagnostics with results:', results);
    logger.debug('VectHare UI: Version data received:', results.version);
    logger.debug('VectHare UI: Extension version:', results.version?.extension);
    logger.debug('VectHare UI: Plugin version:', results.version?.plugin);

    const statusIcons = {
        'pass': '<i class="fa-solid fa-circle-check" style="color: var(--vecthare-success);"></i>',
        'warning': '<i class="fa-solid fa-triangle-exclamation" style="color: var(--vecthare-warning);"></i>',
        'fail': '<i class="fa-solid fa-circle-xmark" style="color: var(--vecthare-danger);"></i>',
        'skipped': '<i class="fa-solid fa-circle-minus" style="color: var(--grey70);"></i>'
    };

    const categoryTitles = {
        infrastructure: '<i class="fa-solid fa-server"></i> Infrastructure',
        configuration: '<i class="fa-solid fa-sliders"></i> Configuration',
        visualizer: '<i class="fa-solid fa-eye"></i> Visualizer',
        production: '<i class="fa-solid fa-vial"></i> Production Tests',
        console: '<i class="fa-solid fa-terminal"></i> Console Logs'
    };

    // Count stats
    const passCount = results.checks.filter(c => c.status === 'pass').length;
    const warnCount = results.checks.filter(c => c.status === 'warning').length;
    const failCount = results.checks.filter(c => c.status === 'fail').length;
    const fixableCount = results.checks.filter(c => c.fixable && (c.status === 'fail' || c.status === 'warning')).length;

    // Filter checks if needed
    const filterCheck = (check) => {
        if (filter === 'all') return true;
        return check.status === filter;
    };

    const renderChecks = (checks) => {
        const filteredChecks = checks.filter(filterCheck);
        if (filteredChecks.length === 0) {
            return '<div class="diagnostic-item-empty">No items match current filter</div>';
        }
        return filteredChecks.map(check => `
            <div class="diagnostic-item ${check.status}" data-fix-action="${check.fixAction || ''}" data-status="${check.status}">
                <div class="diagnostic-main">
                    <span class="diagnostic-icon">${statusIcons[check.status]}</span>
                    <span class="diagnostic-label">${check.name}</span>
                    <span class="diagnostic-message">${check.message}</span>
                </div>
                ${check.fixable ? `
                    <button class="diagnostic-fix-btn" data-fix-action="${check.fixAction}">
                        <i class="fa-solid fa-wrench"></i>
                        Fix
                    </button>
                ` : ''}
            </div>
        `).join('');
    };

    const html = `
        <!-- Version Info -->
        <div class="vecthare-diagnostics-version" style="padding: 10px 15px; background: var(--black30alpha); border-radius: 8px; margin-bottom: 15px; font-size: 0.9em; color: var(--grey70);">
            <i class="fa-solid fa-info-circle"></i>
            <strong>Extension:</strong> v${results.version?.extension || 'Unknown'}
            <span style="margin: 0 10px;">•</span>
            <strong>Plugin:</strong> v${results.version?.plugin || 'Not installed'}
        </div>

        <!-- Summary Stats Bar (Clickable Filters) -->
        <div class="vecthare-diagnostics-stats">
            <div class="vecthare-diag-stat pass ${filter === 'pass' ? 'active' : ''}" data-filter="pass" title="Click to filter by passed">
                ${statusIcons.pass}
                <span class="vecthare-diag-stat-count">${passCount}</span>
                <span class="vecthare-diag-stat-label">Passed</span>
            </div>
            <div class="vecthare-diag-stat warning ${filter === 'warning' ? 'active' : ''}" data-filter="warning" title="Click to filter by warnings">
                ${statusIcons.warning}
                <span class="vecthare-diag-stat-count">${warnCount}</span>
                <span class="vecthare-diag-stat-label">Warnings</span>
            </div>
            <div class="vecthare-diag-stat fail ${filter === 'fail' ? 'active' : ''}" data-filter="fail" title="Click to filter by failed">
                ${statusIcons.fail}
                <span class="vecthare-diag-stat-count">${failCount}</span>
                <span class="vecthare-diag-stat-label">Failed</span>
            </div>
        </div>

        ${filter !== 'all' ? `
            <div class="vecthare-diag-filter-notice">
                <span>Showing only: <strong>${filter}</strong></span>
                <button class="vecthare-diag-clear-filter" data-filter="all">
                    <i class="fa-solid fa-times"></i> Show All
                </button>
            </div>
        ` : ''}

        ${Object.entries(results.categories).map(([category, checks]) => {
            if (checks.length === 0) return '';

            // Category-level stats
            const catPass = checks.filter(c => c.status === 'pass').length;
            const catWarn = checks.filter(c => c.status === 'warning').length;
            const catFail = checks.filter(c => c.status === 'fail').length;
            const filteredCount = checks.filter(filterCheck).length;

            // Don't show category if all items filtered out
            if (filter !== 'all' && filteredCount === 0) return '';

            return `
                <div class="diagnostic-category" data-category="${category}">
                    <div class="diagnostic-category-header" data-collapsed="false">
                        <h4 class="diagnostic-category-title">
                            <span class="diagnostic-category-collapse-icon">
                                <i class="fa-solid fa-chevron-down"></i>
                            </span>
                            ${categoryTitles[category] || `<i class="fa-solid fa-folder"></i> ${category}`}
                        </h4>
                        <div class="diagnostic-category-stats">
                            <span class="diag-cat-stat pass" title="Passed">${catPass}</span>
                            <span class="diag-cat-stat warning" title="Warnings">${catWarn}</span>
                            <span class="diag-cat-stat fail" title="Failed">${catFail}</span>
                        </div>
                    </div>
                    <div class="diagnostic-category-content">
                        <div class="vecthare-diagnostics">
                            ${renderChecks(checks)}
                        </div>
                    </div>
                </div>
            `;
        }).join('')}
    `;

    output.html(html);

    // Update title based on results
    const titleText = results.overall === 'healthy'
        ? 'All Checks Passed!'
        : results.overall === 'warnings'
            ? 'Completed with Warnings'
            : 'Issues Found';
    $('#vecthare_diagnostics_title').text(titleText);

    // Show/hide Fix All button based on fixable issues
    if (fixableCount > 0) {
        $('#vecthare_diag_fix_all')
            .show()
            .html(`<i class="fa-solid fa-wand-magic-sparkles"></i> Fix All (${fixableCount})`)
            .off('click')
            .on('click', function() {
                handleFixAll(results.checks);
            });
    } else {
        $('#vecthare_diag_fix_all').hide();
    }

    // Bind filter click handlers on stat boxes
    $('.vecthare-diag-stat').off('click').on('click', function() {
        const clickedFilter = $(this).data('filter');
        // Toggle: if already active, show all; otherwise apply filter
        if (currentDiagnosticFilter === clickedFilter) {
            currentDiagnosticFilter = 'all';
        } else {
            currentDiagnosticFilter = clickedFilter;
        }
        renderDiagnosticsContent(currentDiagnosticResults, currentDiagnosticFilter);
    });

    // Bind clear filter button
    $('.vecthare-diag-clear-filter').off('click').on('click', function() {
        currentDiagnosticFilter = 'all';
        renderDiagnosticsContent(currentDiagnosticResults, 'all');
    });

    // Bind category collapse handlers
    $('.diagnostic-category-header').off('click').on('click', function() {
        const $header = $(this);
        const $content = $header.next('.diagnostic-category-content');
        const isCollapsed = $header.attr('data-collapsed') === 'true';

        if (isCollapsed) {
            $content.slideDown(200);
            $header.attr('data-collapsed', 'false');
            $header.find('.diagnostic-category-collapse-icon i').removeClass('fa-chevron-right').addClass('fa-chevron-down');
        } else {
            $content.slideUp(200);
            $header.attr('data-collapsed', 'true');
            $header.find('.diagnostic-category-collapse-icon i').removeClass('fa-chevron-down').addClass('fa-chevron-right');
        }
    });

    // Bind individual fix button click handlers
    $('.diagnostic-fix-btn').off('click').on('click', function(e) {
        e.stopPropagation();
        const action = $(this).data('fix-action');
        handleDiagnosticFix(action);
        // Mark this item as fixed visually
        $(this).closest('.diagnostic-item')
            .removeClass('fail warning')
            .addClass('pass')
            .find('.diagnostic-icon').html(statusIcons.pass);
        $(this).fadeOut(200);
    });

    // Bind copy button
    $('#vecthare_diag_copy').off('click').on('click', function() {
        copyDiagnosticsReport(currentDiagnosticResults);
    });
}

/**
 * Generates and copies a nicely formatted diagnostics report
 * Respects the current filter selection
 * @param {object} results - Diagnostics results object
 */
function copyDiagnosticsReport(results) {
    if (!results) {
        toastr.warning('No diagnostic results to copy');
        return;
    }

    const filter = currentDiagnosticFilter;
    const isFiltered = filter !== 'all';

    // Filter checks if a specific filter is active
    const filterCheck = (check) => {
        if (!isFiltered) return true;
        return check.status === filter;
    };

    const timestamp = new Date(results.timestamp).toLocaleString();

    // Total counts (always show these for context)
    const totalPass = results.checks.filter(c => c.status === 'pass').length;
    const totalWarn = results.checks.filter(c => c.status === 'warning').length;
    const totalFail = results.checks.filter(c => c.status === 'fail').length;
    const totalCount = totalPass + totalWarn + totalFail;

    // Filtered counts
    const filteredChecks = results.checks.filter(filterCheck);
    const filteredCount = filteredChecks.length;

    const statusSymbols = {
        'pass': '✓',
        'warning': '⚠',
        'fail': '✗',
        'skipped': '○'
    };

    const filterNames = {
        'pass': 'PASSED ONLY',
        'warning': 'WARNINGS ONLY',
        'fail': 'FAILURES ONLY'
    };

    // Get current settings for the report
    const settings = extension_settings.vecthare;
    const backend = settings.vector_backend || 'standard';
    const source = settings.source || 'none';
    const modelField = getModelField(source);
    const model = modelField ? (settings[modelField] || 'not set') : 'n/a (provider handles it)';
    const qdrantMode = settings.qdrant_mode || 'local';
    const qdrantUrl = backend === 'qdrant'
        ? (qdrantMode === 'cloud' ? settings.qdrant_cloud_url : settings.qdrant_url)
        : null;

    // Build provider URL info
    let providerUrl = 'n/a';
    if (settings.use_alt_endpoint && settings.alt_endpoint_url) {
        providerUrl = settings.alt_endpoint_url;
    } else if (['bananabread', 'ollama', 'llamacpp', 'koboldcpp', 'vllm'].includes(source)) {
        // Local server providers - show their configured URL
        providerUrl = settings.alt_endpoint_url || 'http://localhost:8008';
    }

    let report = `╔══════════════════════════════════════════════════════════════╗
║              VECTHARE DIAGNOSTICS REPORT                      ║
╚══════════════════════════════════════════════════════════════╝

📅 Generated: ${timestamp}
📦 Extension Version: ${results.version?.extension || 'Unknown'}
🔌 Plugin Version: ${results.version?.plugin || 'Not installed'}
${isFiltered ? `🔍 Filter: ${filterNames[filter]} (${filteredCount} of ${totalCount} checks)\n` : ''}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                      CURRENT SETTINGS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Backend:           ${backend}${backend === 'qdrant' ? ` (${qdrantMode})` : ''}
  Embedding Source:  ${source}
  Model:             ${model}${providerUrl !== 'n/a' ? `\n  Provider URL:      ${providerUrl}` : ''}${qdrantUrl ? `\n  Qdrant URL:        ${qdrantUrl}` : ''}
  Chunk Size:        ${settings.chunk_size || 500} chars (adaptive only)
  Score Threshold:   ${settings.score_threshold || 0.5}
  Query Depth:       ${settings.query || 3}
  Chat Auto-Sync:    ${settings.enabled_chats ? 'enabled' : 'disabled'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                         SUMMARY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  ✓ Passed:   ${String(totalPass).padStart(3)}${filter === 'pass' ? ' ◀ showing' : ''}
  ⚠ Warnings: ${String(totalWarn).padStart(3)}${filter === 'warning' ? ' ◀ showing' : ''}
  ✗ Failed:   ${String(totalFail).padStart(3)}${filter === 'fail' ? ' ◀ showing' : ''}
  ─────────────────
  Total:      ${String(totalCount).padStart(3)}

`;

    const categoryNames = {
        infrastructure: '🔧 INFRASTRUCTURE',
        configuration: '⚙️  CONFIGURATION',
        visualizer: '👁️  VISUALIZER',
        production: '🧪 PRODUCTION TESTS',
        console: '💻 CONSOLE LOGS'
    };

    for (const [category, checks] of Object.entries(results.categories)) {
        // Filter checks for this category
        const filteredCatChecks = checks.filter(filterCheck);
        if (filteredCatChecks.length === 0) continue;

        // Show filtered counts vs total for this category
        const catTotal = checks.length;
        const catFiltered = filteredCatChecks.length;
        const catStats = isFiltered
            ? `(${catFiltered} of ${catTotal})`
            : `(✓${checks.filter(c => c.status === 'pass').length} ⚠${checks.filter(c => c.status === 'warning').length} ✗${checks.filter(c => c.status === 'fail').length})`;

        report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
${categoryNames[category] || category.toUpperCase()}  ${catStats}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;

        for (const check of filteredCatChecks) {
            const symbol = statusSymbols[check.status] || '?';
            const name = check.name.padEnd(28);
            report += `  ${symbol} ${name} ${check.message}\n`;
        }

        report += '\n';
    }

    // Add console errors if present (only when showing all or failures)
    if (results.consoleErrors && results.consoleErrors.length > 0 && (!isFiltered || filter === 'fail')) {
        report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💻 CONSOLE ERRORS CAPTURED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

`;
        for (const error of results.consoleErrors) {
            report += `  [${error.type.toUpperCase()}] ${error.message}\n`;
            if (error.stack) {
                report += `           ${error.stack.split('\n')[0]}\n`;
            }
        }
        report += '\n';
    }

    report += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                      END OF REPORT
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;

    // Copy to clipboard
    const filterMsg = isFiltered ? ` (${filterNames[filter]})` : '';
    navigator.clipboard.writeText(report).then(() => {
        toastr.success(`Diagnostics report${filterMsg} copied to clipboard`, 'VectHare');
    }).catch(err => {
        console.error('Failed to copy:', err);
        toastr.error('Failed to copy report');
    });
}

/**
 * Opens the diagnostics modal (starts at selection phase)
 */
export function openDiagnosticsModal() {
    showDiagnosticsPhase('selection');
    $('#vecthare_diagnostics_title').text('Run Diagnostics');
    $('#vecthare_diag_production').prop('checked', !!extension_settings.vecthare?.include_production_tests);
    $('#vecthare_diagnostics_modal').fadeIn(200);
}

/**
 * Handles fixing all fixable issues
 * @param {Array} checks - Array of diagnostic checks
 */
function handleFixAll(checks) {
    const fixableChecks = checks.filter(c => c.fixable && (c.status === 'fail' || c.status === 'warning'));

    if (fixableChecks.length === 0) {
        toastr.info('No fixable issues found');
        return;
    }

    let fixedCount = 0;
    const statusIcons = {
        'pass': '<i class="fa-solid fa-circle-check" style="color: var(--vecthare-success);"></i>'
    };

    fixableChecks.forEach(check => {
        try {
            handleDiagnosticFix(check.fixAction, true); // silent mode
            fixedCount++;

            // Update UI for this item
            $(`.diagnostic-item[data-fix-action="${check.fixAction}"]`)
                .removeClass('fail warning')
                .addClass('pass')
                .find('.diagnostic-icon').html(statusIcons.pass);
            $(`.diagnostic-item[data-fix-action="${check.fixAction}"] .diagnostic-fix-btn`).fadeOut(200);
        } catch (e) {
            console.warn(`Failed to fix: ${check.fixAction}`, e);
        }
    });

    // Hide Fix All button after use
    $('#vecthare_diag_fix_all').fadeOut(200);

    toastr.success(`Fixed ${fixedCount} issue${fixedCount !== 1 ? 's' : ''}`);
}

/**
 * Handles diagnostic fix actions
 * @param {string} action - The fix action to perform
 * @param {boolean} silent - If true, suppress toast notifications and don't close modal
 */
function handleDiagnosticFix(action, silent = false) {
    const settings = extension_settings.vecthare;

    switch (action) {
        case 'enable_chats':
            $('#vecthare_autosync_enabled').prop('checked', true).trigger('change');
            if (!silent) toastr.success('Chat auto-sync enabled');
            break;

        case 'vectorize_all':
            $('#vecthare_vectorize_all').click();
            break;

        case 'configure_provider':
            // Scroll to provider settings
            $('#vecthare_provider_settings')[0]?.scrollIntoView({ behavior: 'smooth' });
            if (!silent) toastr.info('Please select an embedding provider');
            break;

        case 'configure_api_key':
            if (!silent) toastr.info('Go to Settings > API Connections to add your API key');
            break;

        case 'configure_url':
            // Scroll to provider settings
            $('#vecthare_provider_settings')[0]?.scrollIntoView({ behavior: 'smooth' });
            if (!silent) toastr.info('Please configure your API URL in the provider settings');
            break;

        case 'fix_threshold':
            $('#vecthare_score_threshold').val(0.25).trigger('change');
            if (!silent) toastr.success('Score threshold reset to 0.25');
            break;

        case 'fix_counts':
            if (settings.insert < 1) {
                $('#vecthare_insert').val(3).trigger('change');
            }
            if ((settings.top_k ?? settings.insert) < 1) {
                $('#vecthare_topk').val(3).trigger('change');
            }
            if (settings.query < 1) {
                $('#vecthare_query').val(2).trigger('change');
            }
            if (!silent) toastr.success('Insert/Query counts fixed');
            break;

        case 'fix_chunk_size':
            $('#vecthare_chunk_size').val(500).trigger('input');
            if (!silent) toastr.success('Chunk size reset to 500');
            break;

        case 'fix_qdrant_dimension':
            // This needs a dialog - don't auto-fix, show options
            if (!silent) {
                showQdrantDimensionFixDialog();
            }
            return; // Don't close modal

        default:
            if (!silent) toastr.error(`Unknown fix action: ${action}`);
    }

    // Only close modal for individual fixes (not batch Fix All)
    if (!silent) {
        setTimeout(() => {
            closeDiagnosticsModal();
        }, 500);
    }
}

/**
 * Shows a dialog with options to fix Qdrant dimension mismatch
 */
async function showQdrantDimensionFixDialog() {
    // Get the check data from the current diagnostics results
    const check = currentDiagnosticResults?.checks?.find(c => c.fixAction === 'fix_qdrant_dimension');
    const data = check?.data || {};

    const collectionDim = data.collectionDimension || '?';
    const currentDim = data.currentDimension || '?';
    const sources = data.collectionSources?.join(', ') || 'unknown';
    const models = data.collectionModels?.length > 0 ? data.collectionModels.join(', ') : '(not recorded)';
    const pointsCount = data.pointsCount || 0;

    const dialogHtml = `
        <div class="vecthare-dimension-fix-dialog">
            <h3 style="margin-top: 0; color: var(--vecthare-danger);">
                <i class="fa-solid fa-triangle-exclamation"></i> Vector Dimension Mismatch
            </h3>

            <div class="vecthare-dimension-info" style="background: var(--SmartThemeBlurTintColor); padding: 12px; border-radius: 8px; margin-bottom: 16px;">
                <p style="margin: 0 0 8px 0;"><strong>Your Qdrant collection:</strong></p>
                <ul style="margin: 0; padding-left: 20px;">
                    <li><strong>${collectionDim}</strong> dimensions</li>
                    <li>Source: <strong>${sources}</strong></li>
                    <li>Model: <strong>${models}</strong></li>
                    <li><strong>${pointsCount.toLocaleString()}</strong> vectors stored</li>
                </ul>

                <p style="margin: 12px 0 8px 0;"><strong>Your current embedding model:</strong></p>
                <ul style="margin: 0; padding-left: 20px;">
                    <li><strong>${currentDim}</strong> dimensions</li>
                </ul>
            </div>

            <p style="margin-bottom: 16px;">These dimensions don't match. You have two options:</p>

            <div class="vecthare-dimension-options" style="display: flex; flex-direction: column; gap: 12px;">
                <button id="vecthare_dim_fix_purge" class="vecthare-btn-danger" style="padding: 12px; text-align: left;">
                    <i class="fa-solid fa-trash"></i>
                    <strong>Purge collection and start fresh</strong>
                    <br><small style="opacity: 0.8;">Delete all ${pointsCount.toLocaleString()} vectors and re-vectorize with your current model</small>
                </button>

                <button id="vecthare_dim_fix_switch" class="vecthare-btn-secondary" style="padding: 12px; text-align: left;">
                    <i class="fa-solid fa-rotate-left"></i>
                    <strong>I'll switch my embedding model back</strong>
                    <br><small style="opacity: 0.8;">Keep your vectors; change your embedding settings to match (${sources}${models !== '(not recorded)' ? ': ' + models : ''})</small>
                </button>

                <button id="vecthare_dim_fix_cancel" class="vecthare-btn-secondary" style="padding: 12px; text-align: left;">
                    <i class="fa-solid fa-clock"></i>
                    <strong>Hold off for now</strong>
                    <br><small style="opacity: 0.8;">I'll figure it out later</small>
                </button>
            </div>
        </div>
    `;

    // Use callGenericPopup for the dialog
    const { callGenericPopup, POPUP_TYPE } = await import('../../../../popup.js');

    callGenericPopup(dialogHtml, POPUP_TYPE.TEXT, '', {
        okButton: false,
        cancelButton: false,
        wide: false,
        allowVerticalScrolling: true,
    });

    // Bind button handlers
    $('#vecthare_dim_fix_purge').off('click').on('click', async () => {
        // Close popup
        $('.popup-button-close').click();

        // Show confirmation
        const confirmHtml = `
            <p><strong>Are you sure you want to purge the Qdrant collection?</strong></p>
            <p>This will delete all <strong>${pointsCount.toLocaleString()}</strong> vectors permanently.</p>
            <p>You'll need to re-vectorize all your chats, lorebooks, and documents.</p>
        `;

        const confirmed = await callGenericPopup(confirmHtml, POPUP_TYPE.CONFIRM, '', {
            okButton: 'Yes, purge it',
            cancelButton: 'Cancel',
        });

        if (confirmed) {
            toastr.info('Purging Qdrant collection...');
            try {
                const response = await pluginRequest('/backend/qdrant/purge-collection', { body: { collectionName: 'vecthare_main' } });

                if (response.ok) {
                    toastr.success('Qdrant collection purged! You can now re-vectorize your content.');
                    closeDiagnosticsModal();
                } else {
                    const error = await response.text();
                    toastr.error(`Failed to purge: ${error}`);
                }
            } catch (e) {
                toastr.error(`Purge failed: ${e.message}`);
            }
        }
    });

    $('#vecthare_dim_fix_switch').off('click').on('click', () => {
        $('.popup-button-close').click();
        toastr.info(`Switch your embedding provider to "${sources}"${models !== '(not recorded)' ? ` with model "${models}"` : ''} to match your stored vectors.`);
        closeDiagnosticsModal();
        // Scroll to provider settings
        $('#vecthare_provider_settings')[0]?.scrollIntoView({ behavior: 'smooth' });
    });

    $('#vecthare_dim_fix_cancel').off('click').on('click', () => {
        $('.popup-button-close').click();
    });
}
