/**
 * ============================================================================
 * VECTHARE DIAGNOSTICS - INDEX
 * ============================================================================
 * Main entry point for diagnostics system
 * Every potential failure point needs a check and fix here
 *
 * @author Coneja Chibi
 * @version 2.2.0-alpha
 * ============================================================================
 */

import {
    checkVectorsExtension,
    checkBackendEndpoints,
    checkServerPlugin,
    checkPluginEndpoints,
    checkLanceDBBackend,
    checkQdrantBackend,
    checkQdrantDimensionMatch,
    checkEmbeddingProvider,
    checkTransformersMemoryLimits,
    checkApiKeys,
    checkApiUrls,
    checkProviderConnectivity,
    checkWebLlmExtension,
    checkBananaBreadConnection
} from './infrastructure.js';

import {
    checkChatEnabled,
    checkChunkSize,
    checkScoreThreshold,
    checkInsertQueryCounts,
    checkChatVectors,
    checkTemporalDecaySettings,
    checkTemporallyBlindChunks,
    checkConditionalActivationModule,
    checkCollectionIdFormat,
    checkHashCollisionRate,
    checkChatMetadataIntegrity,
    checkConditionRuleValidity,
    checkCollectionRegistryStatus,
    checkChunkGroupsModule,
    checkChunkGroupsValidity,
    checkChunkGroupMemberIntegrity,
    checkPromptContextConfig,
    checkPNGExportCapability
} from './configuration.js';

import {
    testEmbeddingGeneration,
    testVectorStorage,
    testVectorRetrieval,
    testVectorDimensions,
    testTemporalDecay,
    testTemporallyBlindChunks,
    testChunkServerSync,
    testDuplicateHashes,
    testPluginEmbeddingGeneration,
    testReciprocalRankFusion,
    testWeightedCombination,
    testKeywordExtraction,
    testKeywordBoosting,
    testLorebookKeywordExtraction,
} from './production-tests.js';

import { testConditionalActivation } from './activation-tests.js';

import { runVisualizerTests } from './visualizer-tests.js';
import { cleanupTestCollections } from '../core/collection-loader.js';

/**
 * Runs all diagnostic checks
 * @param {object} settings VectHare settings
 * @param {boolean} includeProductionTests Include integration/production tests
 * @returns {Promise<object>} Diagnostics results
 */
export async function runDiagnostics(settings, includeProductionTests = false) {
    console.log('VectHare Diagnostics: Running health checks...');

    // Get version information
    let extensionVersion = 'Unknown';
    let pluginVersion = 'Not installed';

    // Try to get extension version from manifest.json
    try {
        // Add cache-busting parameter to ensure fresh fetch
        const manifestUrl = `/scripts/extensions/third-party/VectHare/manifest.json?_=${Date.now()}`;
        console.log('VectHare Diagnostics: Fetching manifest from:', manifestUrl);
        const manifestResponse = await fetch(manifestUrl);
        console.log('VectHare Diagnostics: Manifest response status:', manifestResponse.status);
        if (manifestResponse.ok) {
            const manifest = await manifestResponse.json();
            console.log('VectHare Diagnostics: Manifest data:', manifest);
            extensionVersion = manifest.version || 'Unknown';
            console.log('VectHare Diagnostics: Extension version:', extensionVersion);
        } else {
            console.warn('VectHare Diagnostics: Manifest fetch failed with status:', manifestResponse.status);
        }
    } catch (error) {
        console.error('VectHare Diagnostics: Could not fetch manifest.json', error);
    }

    // Try to get plugin version from health endpoint
    try {
        const response = await fetch('/api/plugins/similharity/health', {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.ok) {
            const data = await response.json();
            pluginVersion = data.version || 'Unknown';
        }
    } catch (error) {
        // Plugin not available
    }

    // Auto-clean any ghost test collections from the registry
    const testCollectionsCleaned = cleanupTestCollections();
    if (testCollectionsCleaned > 0) {
        console.log(`VectHare Diagnostics: Cleaned ${testCollectionsCleaned} ghost test collections from registry`);
    }

    const categories = {
        infrastructure: [],
        configuration: [],
        visualizer: [],
        production: []
    };

    // ========== INFRASTRUCTURE CHECKS ==========
    categories.infrastructure.push(await checkVectorsExtension());
    categories.infrastructure.push(await checkBackendEndpoints(settings));
    categories.infrastructure.push(await checkServerPlugin());
    categories.infrastructure.push(await checkPluginEndpoints());
    categories.infrastructure.push(await checkLanceDBBackend(settings));
    categories.infrastructure.push(await checkQdrantBackend(settings));
    categories.infrastructure.push(await checkQdrantDimensionMatch(settings));
    categories.infrastructure.push(await checkEmbeddingProvider(settings));

    // WASM memory warning for Transformers users
    const wasmCheck = checkTransformersMemoryLimits(settings);
    if (wasmCheck.status !== 'skipped') {
        categories.infrastructure.push(wasmCheck);
    }

    const apiKeyCheck = checkApiKeys(settings);
    if (apiKeyCheck.status !== 'skipped') {
        categories.infrastructure.push(apiKeyCheck);
    }

    const apiUrlCheck = checkApiUrls(settings);
    if (apiUrlCheck.status !== 'skipped') {
        categories.infrastructure.push(apiUrlCheck);
    }

    categories.infrastructure.push(await checkProviderConnectivity(settings));

    // WebLLM-specific check (only if WebLLM is selected)
    const webllmCheck = checkWebLlmExtension(settings);
    if (webllmCheck.status !== 'skipped') {
        categories.infrastructure.push(webllmCheck);
    }

    // BananaBread check (only if BananaBread is selected)
    const bananabreadCheck = await checkBananaBreadConnection(settings);
    if (bananabreadCheck.status !== 'skipped') {
        categories.infrastructure.push(bananabreadCheck);
    }

    // ========== CONFIGURATION CHECKS ==========
    categories.configuration.push(checkChatEnabled(settings));
    categories.configuration.push(checkChunkSize(settings));
    categories.configuration.push(checkScoreThreshold(settings));
    categories.configuration.push(checkInsertQueryCounts(settings));
    categories.configuration.push(await checkChatVectors(settings));

    // Temporal decay is now per-collection, always report status
    categories.configuration.push(checkTemporalDecaySettings(settings));
    categories.configuration.push(await checkTemporallyBlindChunks(settings));

    // Conditional activation checks
    categories.configuration.push(checkConditionalActivationModule());

    // Collection ID format check (UUID-based multitenancy)
    categories.configuration.push(checkCollectionIdFormat());

    // Hash collision rate (informational - collisions are intentional deduplication)
    categories.configuration.push(await checkHashCollisionRate(settings));

    // Chat metadata integrity (UUID-based collection tracking)
    categories.configuration.push(checkChatMetadataIntegrity());

    // Condition rule validity (validates chunk condition rules)
    categories.configuration.push(await checkConditionRuleValidity(settings));

    // Collection registry status (verifies collections are discoverable)
    categories.configuration.push(await checkCollectionRegistryStatus(settings));

    // Chunk groups module and validity checks
    categories.configuration.push(await checkChunkGroupsModule());
    categories.configuration.push(await checkChunkGroupsValidity(settings));
    categories.configuration.push(await checkChunkGroupMemberIntegrity(settings));

    // Prompt context configuration
    categories.configuration.push(await checkPromptContextConfig(settings));

    // PNG export capability
    categories.configuration.push(checkPNGExportCapability());

    // ========== VISUALIZER CHECKS ==========
    // Fast checks always run, slow (API) checks only with production tests
    const visualizerResults = await runVisualizerTests(settings, includeProductionTests);
    categories.visualizer.push(...visualizerResults);

    // ========== PRODUCTION TESTS (Optional) ==========
    if (includeProductionTests) {
        categories.production.push(await testEmbeddingGeneration(settings));
        categories.production.push(await testVectorStorage(settings));
        categories.production.push(await testVectorRetrieval(settings));
        categories.production.push(await testVectorDimensions(settings));
        categories.production.push(await testTemporalDecay(settings));
        categories.production.push(await testTemporallyBlindChunks(settings));
        categories.production.push(await testChunkServerSync(settings));
        categories.production.push(await testDuplicateHashes(settings));
        // Plugin-specific embedding generation test (LanceDB/Qdrant)
        categories.production.push(await testPluginEmbeddingGeneration(settings));
        
        // Hybrid search tests
        categories.production.push(await testReciprocalRankFusion(settings));
        categories.production.push(await testWeightedCombination(settings));
        
        // Keyword system tests
        categories.production.push(await testKeywordExtraction(settings));
        categories.production.push(await testKeywordBoosting(settings));
        categories.production.push(await testLorebookKeywordExtraction(settings));
        
        // Conditional activation returns an array of individual test results
        const activationResults = await testConditionalActivation();
        categories.production.push(...activationResults);
    }

    // Flatten all checks
    const allChecks = [
        ...categories.infrastructure,
        ...categories.configuration,
        ...categories.visualizer,
        ...categories.production
    ];

    // Determine overall status
    const failCount = allChecks.filter(c => c.status === 'fail').length;
    const warnCount = allChecks.filter(c => c.status === 'warning').length;

    const overall = failCount > 0 ? 'issues' : warnCount > 0 ? 'warnings' : 'healthy';

    const results = {
        version: {
            extension: extensionVersion,
            plugin: pluginVersion
        },
        categories,
        checks: allChecks,
        overall,
        timestamp: new Date().toISOString()
    };

    console.log('VectHare Diagnostics: Complete', results);
    console.log('VectHare Diagnostics: Version object:', results.version);
    console.log('VectHare Diagnostics: Extension version in results:', results.version.extension);
    console.log('VectHare Diagnostics: Plugin version in results:', results.version.plugin);

    return results;
}

