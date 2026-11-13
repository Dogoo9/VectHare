/**
 * HTML for the VectHare settings panel (rendered once by renderSettings).
 */

import { getHealthIndicatorHtml, getHealthModalHtml } from './health-dashboard.js';
import { getAlternativeEndpointHtml } from './endpoint-presets.js';

/** @returns {string} */
export function getSettingsHtml() {
    return `
        <div id="vecthare_settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>VectHare - Advanced RAG</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">

                    <!-- Core Settings Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-cog"></i>
                                </span>
                                Core Settings
                            </h3>
                            <p class="vecthare-card-subtitle">Configure embedding provider and vectorization parameters</p>
                        </div>
                        <div class="vecthare-card-body">

                            <label for="vecthare_vector_backend">
                                <small>Vector Backend</small>
                            </label>
                            <select id="vecthare_vector_backend" class="vecthare-select">
                                <option value="standard">Standard (ST's Vectra - file-based)</option>
                                <option value="lancedb">LanceDB (disk-based, scalable)</option>
                                <option value="qdrant">Qdrant (production vector search)</option>
                                <option value="milvus">Milvus (popular open source engine)</option>
                            </select>
                            <small class="vecthare-help-text" style="display: block; margin-top: -8px; margin-bottom: 16px; opacity: 0.7; font-size: 0.85em; line-height: 1.5;">
                                • Standard: ST's built-in Vectra (best for <100k vectors)<br>
                                • LanceDB: Disk-based, handles millions of vectors (requires plugin)<br>
                                • Qdrant: Production-grade with HNSW, filtering, cloud support<br>
                                • Milvus: High-performance, scalable vector database
                            </small>

                            <!-- Qdrant Settings (shown only when Qdrant backend is selected) -->
                            <div id="vecthare_qdrant_settings" style="display: none;">
                                <label class="checkbox_label">
                                    <input type="checkbox" id="vecthare_qdrant_use_cloud" />
                                    <span>Use Qdrant Cloud</span>
                                </label>

                                <!-- Local Qdrant Settings -->
                                <div id="vecthare_qdrant_local_settings">
                                    <label for="vecthare_qdrant_host">
                                        <small>Qdrant Host:</small>
                                    </label>
                                    <input type="text" id="vecthare_qdrant_host" class="vecthare-input" placeholder="localhost" />

                                    <label for="vecthare_qdrant_port">
                                        <small>Qdrant Port:</small>
                                    </label>
                                    <input type="number" id="vecthare_qdrant_port" class="vecthare-input" placeholder="6333" />
                                </div>

                                <!-- Cloud Qdrant Settings -->
                                <div id="vecthare_qdrant_cloud_settings" style="display: none;">
                                    <label for="vecthare_qdrant_url">
                                        <small>Qdrant Cloud URL:</small>
                                    </label>
                                    <input type="text" id="vecthare_qdrant_url" class="vecthare-input" placeholder="https://xxx.cloud.qdrant.io" />

                                    <label for="vecthare_qdrant_api_key">
                                        <small>API Key:</small>
                                    </label>
                                    <input type="password" id="vecthare_qdrant_api_key" class="vecthare-input" placeholder="Your Qdrant Cloud API key" />
                                </div>

                                <!-- Qdrant Multitenancy Setting -->
                                <div style="margin-top: 10px; padding: 8px; background: rgba(0,0,0,0.1); border-radius: 4px;">
                                    <label class="checkbox_label" title="When enabled, uses a single Qdrant collection with content_type filtering (multitenancy). When disabled, creates separate collections for each content type (better isolation).">
                                        <input type="checkbox" id="vecthare_qdrant_multitenancy" />
                                        <span>Use Multitenancy (Single Collection)</span>
                                    </label>
                                    <small class="vecthare_hint" style="display: block; margin-top: 4px;">
                                        <strong>Multitenancy ON:</strong> Single collection with filtering (saves resources)<br>
                                        <strong>Multitenancy OFF:</strong> Separate collections per content type (better isolation)
                                    </small>
                                </div>
                            </div>

                            <!-- Milvus Settings (shown only when Milvus backend is selected) -->
                            <div id="vecthare_milvus_settings" style="display: none;">
                                <label for="vecthare_milvus_host">
                                    <small>Milvus Host:</small>
                                </label>
                                <input type="text" id="vecthare_milvus_host" class="vecthare-input" placeholder="localhost" />

                                <label for="vecthare_milvus_port">
                                    <small>Milvus Port:</small>
                                </label>
                                <input type="number" id="vecthare_milvus_port" class="vecthare-input" placeholder="19530" />

                                <label for="vecthare_milvus_address">
                                    <small>Full Address (Optional):</small>
                                </label>
                                <input type="text" id="vecthare_milvus_address" class="vecthare-input" placeholder="http://localhost:19530" />
                                <small class="vecthare_hint">Overrides Host/Port if set (e.g. for cloud instances)</small>

                                <label for="vecthare_milvus_username">
                                    <small>Username (Optional):</small>
                                </label>
                                <input type="text" id="vecthare_milvus_username" class="vecthare-input" />

                                <label for="vecthare_milvus_password">
                                    <small>Password (Optional):</small>
                                </label>
                                <input type="password" id="vecthare_milvus_password" class="vecthare-input" />

                                <label for="vecthare_milvus_token">
                                    <small>API Token (Optional):</small>
                                </label>
                                <input type="password" id="vecthare_milvus_token" class="vecthare-input" placeholder="For cloud instances" />

                                <label for="vecthare_milvus_dimensions">
                                    <small>Embedding Dimensions:</small>
                                </label>
                                <input type="number" id="vecthare_milvus_dimensions" class="vecthare-input" placeholder="Auto (768)" min="1" />
                                <small class="vecthare_hint">Manually set dimension size if auto-detection fails (e.g. 1536, 4096). Required for some models on first run.</small>
                            </div>

                            <label for="vecthare_source">
                                <small>Embedding Provider</small>
                            </label>
                            <select id="vecthare_source" class="vecthare-select">
                            <option value="transformers">Transformers (Local)</option>
                            <option value="bananabread">BananaBread</option>
                            <option value="openai">OpenAI</option>
                            <option value="ollama">Ollama</option>
                            <option value="cohere">Cohere</option>
                            <option value="togetherai">Together AI</option>
                            <option value="extras">Extras API</option>
                            <option value="electronhub">ElectronHub</option>
                            <option value="openrouter">OpenRouter</option>
                            <option value="llamacpp">LlamaCPP</option>
                            <option value="vllm">vLLM</option>
                            <option value="koboldcpp">KoboldCPP</option>
                            <option value="webllm">WebLLM</option>
                            <option value="palm">Google PaLM</option>
                            <option value="vertexai">Google VertexAI</option>
                            <option value="mistral">Mistral AI</option>
                            <option value="nomicai">Nomic AI</option>
                        </select>

                        <!-- Provider-Specific Settings -->
                        <div id="vecthare_provider_settings">

                            <!-- ElectronHub Model -->
                            <div class="vecthare_provider_setting" data-provider="electronhub">
                                <label for="vecthare_electronhub_model">
                                    <small>ElectronHub Model:</small>
                                </label>
                                <input type="text" id="vecthare_electronhub_model" class="vecthare-input" placeholder="text-embedding-3-small" />
                                <small class="vecthare_hint">Enter ElectronHub-compatible model ID (e.g., text-embedding-3-small, text-embedding-3-large)</small>
                            </div>

                            <!-- Alternative Endpoint (for local providers) -->
                            ${getAlternativeEndpointHtml()}

                            <!-- BananaBread Info & Reranking -->
                            <div class="vecthare_provider_setting" data-provider="bananabread">
                                <small class="vecthare_info">
                                    <i class="fa-solid fa-info-circle"></i>
                                    BananaBread default: http://localhost:8008. Supports MixedBread AI and Qwen3 embedding models.
                                </small>
                                <label class="checkbox_label" style="margin-top: 8px;">
                                    <input type="checkbox" id="vecthare_bananabread_rerank" />
                                    <span>Enable Reranking</span>
                                </label>
                                <small class="vecthare_hint">Re-score results using BananaBread's reranker for better relevance</small>
                                <label for="vecthare_bananabread_apikey" style="margin-top: 8px;">
                                    <small>BananaBread API Key:</small>
                                </label>
                                <input type="password" id="vecthare_bananabread_apikey" class="vecthare-input" placeholder="Paste key here to save..." autocomplete="off" />
                            </div>

                            <!-- WebLLM Model -->
                            <div class="vecthare_provider_setting" data-provider="webllm">
                                <small class="vecthare_info" id="vecthare_webllm_status">
                                    <i class="fa-solid fa-spinner fa-spin"></i>
                                    Checking WebLLM availability...
                                </small>
                                <label for="vecthare_webllm_model">
                                    <small>WebLLM Model:</small>
                                </label>
                                <select id="vecthare_webllm_model" class="vecthare-select"></select>
                                <div style="display: flex; gap: 8px; margin-top: 8px;">
                                    <button id="vecthare_webllm_load" class="menu_button">
                                        <i class="fa-solid fa-download"></i> Load Model
                                    </button>
                                    <button id="vecthare_webllm_install" class="menu_button menu_button_icon">
                                        <i class="fa-solid fa-puzzle-piece"></i> Install Extension
                                    </button>
                                </div>
                                <small class="vecthare_hint">WebLLM requires the WebLLM extension and a WebGPU-compatible browser (Chrome 113+, Edge 113+)</small>
                            </div>

                            <!-- Ollama Model -->
                            <div class="vecthare_provider_setting" data-provider="ollama">
                                <label for="vecthare_ollama_model">
                                    <small>Ollama Model:</small>
                                </label>
                                <input type="text" id="vecthare_ollama_model" class="vecthare-input" placeholder="mxbai-embed-large" />
                                <label class="checkbox_label">
                                    <input type="checkbox" id="vecthare_ollama_keep" />
                                    <span>Keep Model in Memory</span>
                                </label>
                                <small class="vecthare_hint">Enter the model name from your local Ollama installation</small>
                            </div>

                            <!-- KoboldCPP Info -->
                            <div class="vecthare_provider_setting" data-provider="koboldcpp">
                                <small class="vecthare_info">
                                    <i class="fa-solid fa-info-circle"></i>
                                    KoboldCPP uses the currently loaded model for embeddings. Ensure your model supports embeddings.
                                </small>
                            </div>

                            <!-- LlamaCPP Info -->
                            <div class="vecthare_provider_setting" data-provider="llamacpp">
                                <small class="vecthare_info">
                                    <i class="fa-solid fa-info-circle"></i>
                                    LlamaCPP requires the --embedding flag to be enabled. Restart your server with this flag if not already set.
                                </small>
                            </div>

                            <!-- OpenAI Model -->
                            <div class="vecthare_provider_setting" data-provider="openai">
                                <label for="vecthare_openai_model">
                                    <small>OpenAI Model:</small>
                                </label>
                                <select id="vecthare_openai_model" class="vecthare-select">
                                    <option value="text-embedding-ada-002">text-embedding-ada-002</option>
                                    <option value="text-embedding-3-small">text-embedding-3-small</option>
                                    <option value="text-embedding-3-large">text-embedding-3-large</option>
                                </select>
                            </div>

                            <!-- Cohere Model -->
                            <div class="vecthare_provider_setting" data-provider="cohere">
                                <label for="vecthare_cohere_model">
                                    <small>Cohere Model:</small>
                                </label>
                                <select id="vecthare_cohere_model" class="vecthare-select">
                                    <option value="embed-english-v3.0">embed-english-v3.0</option>
                                    <option value="embed-multilingual-v3.0">embed-multilingual-v3.0</option>
                                    <option value="embed-english-light-v3.0">embed-english-light-v3.0</option>
                                    <option value="embed-multilingual-light-v3.0">embed-multilingual-light-v3.0</option>
                                    <option value="embed-english-v2.0">embed-english-v2.0</option>
                                    <option value="embed-english-light-v2.0">embed-english-light-v2.0</option>
                                    <option value="embed-multilingual-v2.0">embed-multilingual-v2.0</option>
                                    <option value="embed-multilingual-light-v2.0">embed-multilingual-light-v2.0</option>
                                </select>
                            </div>

                            <!-- TogetherAI Model -->
                            <div class="vecthare_provider_setting" data-provider="togetherai">
                                <label for="vecthare_togetherai_model">
                                    <small>Together AI Model:</small>
                                </label>
                                <select id="vecthare_togetherai_model" class="vecthare-select">
                                    <option value="togethercomputer/m2-bert-80M-32k-retrieval">togethercomputer/m2-bert-80M-32k-retrieval</option>
                                    <option value="togethercomputer/m2-bert-80M-8k-retrieval">togethercomputer/m2-bert-80M-8k-retrieval</option>
                                    <option value="togethercomputer/m2-bert-80M-2k-retrieval">togethercomputer/m2-bert-80M-2k-retrieval</option>
                                    <option value="WhereIsAI/UAE-Large-V1">WhereIsAI/UAE-Large-V1</option>
                                    <option value="BAAI/bge-large-en-v1.5">BAAI/bge-large-en-v1.5</option>
                                    <option value="BAAI/bge-base-en-v1.5">BAAI/bge-base-en-v1.5</option>
                                    <option value="sentence-transformers/msmarco-bert-base-dot-v5">sentence-transformers/msmarco-bert-base-dot-v5</option>
                                    <option value="bert-base-uncased">bert-base-uncased</option>
                                </select>
                            </div>

                            <!-- vLLM Model -->
                            <div class="vecthare_provider_setting" data-provider="vllm">
                                <label for="vecthare_vllm_model">
                                    <small>vLLM Model:</small>
                                </label>
                                <input type="text" id="vecthare_vllm_model" class="vecthare-input" placeholder="Model name" />
                                <small class="vecthare_hint">Enter the model name from your vLLM deployment</small>
                            </div>

                            <!-- Google Model (PaLM/VertexAI) -->
                            <div class="vecthare_provider_setting" data-provider="palm,vertexai">
                                <label for="vecthare_google_model">
                                    <small>Google Model:</small>
                                </label>
                                <select id="vecthare_google_model" class="vecthare-select">
                                    <option value="text-embedding-005">text-embedding-005</option>
                                    <option value="text-embedding-004">text-embedding-004</option>
                                    <option value="text-multilingual-embedding-002">text-multilingual-embedding-002</option>
                                    <option value="textembedding-gecko">textembedding-gecko</option>
                                    <option value="textembedding-gecko-multilingual">textembedding-gecko-multilingual</option>
                                </select>
                            </div>

                            <!-- NomicAI API Key -->
                            <div class="vecthare_provider_setting" data-provider="nomicai">
                                <button id="vecthare_nomicai_api_key" class="menu_button">
                                    <i class="fa-solid fa-key"></i> Set Nomic API Key
                                </button>
                                <small class="vecthare_hint">Configure your Nomic API key in SillyTavern settings</small>
                            </div>

                            <!-- OpenRouter Model -->
                            <div class="vecthare_provider_setting" data-provider="openrouter">
                                <label for="vecthare_openrouter_model">
                                    <small>OpenRouter Model:</small>
                                </label>
                                <input type="text" id="vecthare_openrouter_model" class="vecthare-input" placeholder="openai/text-embedding-3-large" />
                                <small class="vecthare_hint">Enter OpenRouter-compatible model ID</small>
                                <label for="vecthare_openrouter_apikey" style="margin-top: 8px;">
                                    <small>OpenRouter API Key:</small>
                                </label>
                                <input type="password" id="vecthare_openrouter_apikey" class="vecthare-input" placeholder="Paste key here to save..." autocomplete="off" />
                            </div>

                        </div>

                            <!-- API Rate Limiting -->
                            <div class="vecthare-setting-group" style="margin-top: 16px; margin-bottom: 16px; padding-top: 16px; border-top: 1px solid var(--grey30);">
                                <label>
                                    <small>API Rate Limiting (0 to disable)</small>
                                </label>
                                <div style="display: flex; gap: 10px;">
                                    <div style="flex: 1;">
                                        <label for="vecthare_rate_limit_calls" style="display: block; margin-bottom: 4px;">
                                            <small>Max Calls</small>
                                        </label>
                                        <input type="number" id="vecthare_rate_limit_calls" class="vecthare-input" min="0" placeholder="5" />
                                    </div>
                                    <div style="flex: 1;">
                                        <label for="vecthare_rate_limit_interval" style="display: block; margin-bottom: 4px;">
                                            <small>Interval (sec)</small>
                                        </label>
                                        <input type="number" id="vecthare_rate_limit_interval" class="vecthare-input" min="1" placeholder="60" />
                                    </div>
                                </div>
                                <small class="vecthare_hint">Limit the number of API requests per time interval</small>
                            </div>

                            <label for="vecthare_insert_batch_size">
                                <small>Insert Batch Size: <span id="vecthare_insert_batch_size_value">50</span></small>
                            </label>
                            <input type="range" id="vecthare_insert_batch_size" class="vecthare-slider" min="10" max="100" step="10" />
                            <small class="vecthare_hint">Chunks per insert batch (50-100 recommended for faster bulk operations)</small>

                            <label for="vecthare_min_chat_length" style="margin-top: 16px;">
                                <small>Minimum Messages Before Injection</small>
                            </label>
                            <input type="number" id="vecthare_min_chat_length" class="vecthare-input" min="0" max="100" step="1" placeholder="0" />
                            <small class="vecthare_hint">Minimum number of messages in chat before RAG injection starts (0 = inject immediately)</small>

                            <label for="vecthare_score_threshold">
                                <small>Similarity Threshold: <span id="vecthare_threshold_value">0.25</span></small>
                            </label>
                            <input type="range" id="vecthare_score_threshold" class="vecthare-slider" min="0" max="1" step="0.05" />
                            <small class="vecthare_hint">Minimum relevance score for retrieval</small>

                            <!-- Keyword Scoring Method -->
                            <label style="margin-top: 16px;">
                                <small>Keyword Scoring Method</small>
                            </label>
                            <select id="vecthare_keyword_scoring_method" class="vecthare-select">
                                <option value="keyword">Keyword Boost</option>
                                <option value="bm25">BM25 (Langchain)</option>
                                <option value="hybrid">Hybrid (Both)</option>
                            </select>
                            <small class="vecthare_hint">Algorithm for keyword-based relevance scoring</small>

                            <!-- BM25 Parameters (shown when BM25 or Hybrid is selected) -->
                            <div id="vecthare_bm25_params" style="display: none; margin-top: 12px; padding: 12px; background: rgba(0,0,0,0.1); border-radius: 8px;">
                                <label for="vecthare_bm25_k1">
                                    <small>BM25 k1 (TF saturation): <span id="vecthare_bm25_k1_value">1.5</span></small>
                                </label>
                                <input type="range" id="vecthare_bm25_k1" class="vecthare-slider" min="0.5" max="3.0" step="0.1" />
                                <small class="vecthare_hint">Controls term frequency saturation (1.2-2.0 typical)</small>

                                <label for="vecthare_bm25_b" style="margin-top: 8px;">
                                    <small>BM25 b (Length norm): <span id="vecthare_bm25_b_value">0.75</span></small>
                                </label>
                                <input type="range" id="vecthare_bm25_b" class="vecthare-slider" min="0" max="1" step="0.05" />
                                <small class="vecthare_hint">Controls document length normalization (0.75 typical)</small>
                            </div>

                            <!-- Hybrid Search (Vector + Full-Text) -->
                            <div style="margin-top: 16px; padding: 12px; background: rgba(0,100,200,0.1); border-radius: 8px; border: 1px solid rgba(0,100,200,0.2);">
                                <label class="checkbox_label" for="vecthare_hybrid_search_enabled" style="margin-bottom: 8px;">
                                    <input id="vecthare_hybrid_search_enabled" type="checkbox" />
                                    <span><small><b>Enable Hybrid Search</b></small></span>
                                </label>
                                <small class="vecthare_hint">Combines vector similarity with full-text (BM25) search using rank fusion</small>

                                <div id="vecthare_hybrid_params" style="display: none; margin-top: 12px;">
                                    <label style="margin-top: 8px;">
                                        <small>Fusion Method</small>
                                    </label>
                                    <select id="vecthare_hybrid_fusion_method" class="vecthare-select">
                                        <option value="rrf">RRF (Reciprocal Rank Fusion)</option>
                                        <option value="weighted">Weighted Linear Combination</option>
                                        <option value="heuristic_weighted">Legacy Heuristic Weighted</option>
                                    </select>
                                    <small class="vecthare_hint">RRF is parameter-free and robust; Weighted allows fine-tuning</small>

                                    <div id="vecthare_hybrid_weights" style="display: none; margin-top: 12px;">
                                        <label for="vecthare_hybrid_vector_weight">
                                            <small>Vector Weight: <span id="vecthare_hybrid_vector_weight_value">0.5</span></small>
                                        </label>
                                        <input type="range" id="vecthare_hybrid_vector_weight" class="vecthare-slider" min="0" max="1" step="0.1" />

                                        <label for="vecthare_hybrid_text_weight" style="margin-top: 8px;">
                                            <small>Text Weight: <span id="vecthare_hybrid_text_weight_value">0.5</span></small>
                                        </label>
                                        <input type="range" id="vecthare_hybrid_text_weight" class="vecthare-slider" min="0" max="1" step="0.1" />
                                    </div>

                                    <div id="vecthare_hybrid_rrf_settings" style="margin-top: 12px;">
                                        <label for="vecthare_hybrid_rrf_k">
                                            <small>RRF K Constant: <span id="vecthare_hybrid_rrf_k_value">60</span></small>
                                        </label>
                                        <input type="range" id="vecthare_hybrid_rrf_k" class="vecthare-slider" min="1" max="100" step="1" />
                                        <small class="vecthare_hint">Higher K = more weight to top-ranked results (60 is typical)</small>
                                    </div>

                                    <label class="checkbox_label" for="vecthare_hybrid_native_prefer" style="margin-top: 12px;">
                                        <input id="vecthare_hybrid_native_prefer" type="checkbox" checked />
                                        <span><small>Prefer Native Backend Hybrid</small></span>
                                    </label>
                                    <small class="vecthare_hint">Use Qdrant/Milvus native hybrid if available (faster)</small>
                                </div>
                            </div>

                            <!-- Custom Stopwords -->
                            <div style="margin-top: 16px; padding: 12px; background: rgba(100,100,100,0.1); border-radius: 8px;">
                                <label for="vecthare_custom_stopwords">
                                    <small><b>Custom Stopwords</b></small>
                                </label>
                                <textarea id="vecthare_custom_stopwords" class="vecthare-textarea" rows="2"
                                    placeholder="{{char}}, {{user}}, character, scene, location..."
                                    style="margin-top: 4px;"></textarea>
                                <small class="vecthare_hint">Words to exclude from keyword extraction. Supports ST macros: {{char}}, {{user}}, {{charIfNotGroup}}, etc.</small>
                            </div>

                            <label for="vecthare_query_depth" style="margin-top: 12px;">
                                <small>Query Depth: <span id="vecthare_query_depth_value">2</span> messages</small>
                            </label>
                            <input type="range" id="vecthare_query_depth" class="vecthare-slider" min="1" max="20" step="1" />
                            <small class="vecthare_hint">How many recent messages to include in search query</small>

                            <label for="vecthare_deduplication_depth" style="margin-top: 12px;">
                                <small>Dedup Depth: <span id="vecthare_deduplication_depth_value">50</span> messages</small>
                            </label>
                            <input type="range" id="vecthare_deduplication_depth" class="vecthare-slider" min="0" max="500" step="10" />
                            <small class="vecthare_hint">Recent messages to check for duplicates (0 = check all, lower = allow older content to resurface)</small>

                            <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
                                <label for="vecthare_topk" style="margin:0; white-space:nowrap;"><small>Max Entries to Inject: <span id="vecthare_topk_value">3</span></small></label>
                                <input id="vecthare_topk" type="range" class="vecthare-slider" min="1" max="500" step="1" />
                                <small class="vecthare_hint" style="margin-left:8px;">Final output cap after enabled-state, keyword, score, and condition filtering</small>
                            </div>
                            <div style="margin-top:8px; display:flex; gap:8px; align-items:center;">
                                <label for="vecthare_candidate_k" style="margin:0; white-space:nowrap;"><small>Qdrant Candidates: <span id="vecthare_candidate_k_value">25</span></small></label>
                                <input id="vecthare_candidate_k" type="range" class="vecthare-slider" min="1" max="500" step="1" />
                                <small class="vecthare_hint" style="margin-left:8px;">Entries searched before filtering; raising this does not inject the whole collection</small>
                                <label for="vecthare_topk" style="margin:0; white-space:nowrap;"><small>Entries to Pull: <span id="vecthare_topk_value">3</span></small></label>
                                <input id="vecthare_topk" type="range" class="vecthare-slider" min="1" max="500" step="1" />
                                <small class="vecthare_hint" style="margin-left:8px;">Final number of entries to inject; Qdrant fetches a larger candidate pool before filtering</small>
                            </div>

                            <label style="margin-top: 16px;">
                                <small>Injection Position</small>
                            </label>
                            <select id="vecthare_injection_position" class="vecthare-select">
                                <option value="2">Before Main Prompt</option>
                                <option value="0">After Main Prompt</option>
                                <option value="1">In-Chat @ Depth</option>
                            </select>
                            <small class="vecthare_hint">Where retrieved chunks appear in the prompt</small>

                            <div id="vecthare_injection_depth_row" style="margin-top: 12px; display: none;">
                                <label for="vecthare_injection_depth">
                                    <small>Injection Depth: <span id="vecthare_injection_depth_value">2</span></small>
                                </label>
                                <input type="range" id="vecthare_injection_depth" class="vecthare-slider" min="0" max="50" step="1" />
                                <small class="vecthare_hint">Messages from end of chat to insert at</small>
                            </div>

                        </div>
                    </div>

                    <!-- Global Temporal Weighting Defaults Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-clock"></i>
                                </span>
                                Temporal Weighting Defaults
                            </h3>
                            <p class="vecthare-card-subtitle">Default settings for new collections (can be overridden per-collection)</p>
                        </div>
                        <div class="vecthare-card-body">

                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                                <input type="checkbox" id="vecthare_default_decay_enabled" />
                                <label for="vecthare_default_decay_enabled" style="margin: 0;">
                                    <small>Enable temporal weighting by default</small>
                                </label>
                            </div>

                            <div id="vecthare_default_decay_type_section" class="vecthare-subsection-disabled">
                                <label style="margin-bottom: 4px;">
                                    <small>Default Type</small>
                                </label>
                                <div style="display: flex; gap: 12px; margin-bottom: 12px;">
                                    <label style="display: flex; align-items: center; gap: 4px; margin: 0;">
                                        <input type="radio" name="vecthare_default_decay_type" value="decay" />
                                        <small>Decay (favor recent)</small>
                                    </label>
                                    <label style="display: flex; align-items: center; gap: 4px; margin: 0;">
                                        <input type="radio" name="vecthare_default_decay_type" value="nostalgia" />
                                        <small>Nostalgia (favor old)</small>
                                    </label>
                                </div>
                            </div>

                            <small class="vecthare_hint">These defaults apply to newly created collections. Existing collections keep their settings.</small>

                        </div>
                    </div>

                    <!-- RAG Context Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-quote-left"></i>
                                </span>
                                RAG Context
                            </h3>
                            <p class="vecthare-card-subtitle">Add context prompts to help the AI understand retrieved content</p>
                        </div>
                        <div class="vecthare-card-body">

                            <label for="vecthare_rag_context">
                                <small>Global Context Prompt</small>
                            </label>
                            <textarea id="vecthare_rag_context" class="vecthare-textarea" rows="3" placeholder="e.g., The following information may be relevant to your conversation with {{user}}:"></textarea>
                            <small class="vecthare_hint">Shown before all RAG content. Supports {{user}} and {{char}} variables.</small>

                            <label for="vecthare_rag_xml_tag" style="margin-top: 12px;">
                                <small>Global XML Tag (optional)</small>
                            </label>
                            <input type="text" id="vecthare_rag_xml_tag" class="vecthare-input" placeholder="e.g., retrieved_context" />
                            <small class="vecthare_hint">Wraps all RAG content in &lt;tag&gt;...&lt;/tag&gt;. Leave empty for no wrapping.</small>

                            <div class="vecthare_info" style="margin-top: 16px; padding: 8px 12px; border-radius: 4px; background: var(--SmartThemeBlurTintColor); font-size: 0.85em;">
                                <i class="fa-solid fa-info-circle"></i>
                                <span>Collection and chunk-level context can be set in the Database Browser and Chunk Visualizer respectively.</span>
                            </div>

                        </div>
                        </div>

                        <!-- World Info Settings Card -->
                        <div class="vecthare-card">
                            <div class="vecthare-card-header">
                                <h3 class="vecthare-card-title">
                                    <span class="vecthare-icon">
                                        <i class="fa-solid fa-globe"></i>
                                    </span>
                                    World Info settings
                                </h3>
                                <p class="vecthare-card-subtitle">Semantic activation of World Info entries from vectorized lorebooks</p>
                            </div>
                            <div class="vecthare-card-body">
                                <label class="checkbox_label" for="vecthare_enabled_world_info" title="Enable semantic activation of World Info entries from vectorized lorebooks based on chat context similarity.">
                                    <input id="vecthare_enabled_world_info" type="checkbox" class="checkbox">
                                    <span>Enable Semantic WI Activation</span>
                                </label>

                                <div id="vecthare_world_info_settings" style="margin-top:10px; display:none;">
                                    <small style="display:block; margin-bottom:8px; opacity:0.85;">
                                        Activates World Info entries from <strong>vectorized lorebooks</strong> based on semantic similarity to recent chat messages. Complements keyword-based activation.
                                    </small>

                                    <div style="display:flex; gap:12px;">
                                        <div style="flex:1;">
                                            <label for="vecthare_world_info_threshold"><small>Score Threshold</small></label>
                                            <input id="vecthare_world_info_threshold" type="number" class="vecthare-input" min="0" max="1" step="0.01" />
                                        </div>
                                        <div style="flex:1;">
                                            <label for="vecthare_world_info_top_k"><small>Top-K per Lorebook</small></label>
                                            <input id="vecthare_world_info_top_k" type="number" class="vecthare-input" min="1" max="20" />
                                        </div>
                                        <div style="flex:1;">
                                            <label for="vecthare_world_info_query_depth"><small>Query Depth</small></label>
                                            <input id="vecthare_world_info_query_depth" type="number" class="vecthare-input" min="1" max="10" />
                                        </div>
                                    </div>

                                    <div style="margin-top:10px;">
                                        <label for="vecthare_wi_test_input"><small>Test Messages (one per line)</small></label>
                                        <textarea id="vecthare_wi_test_input" class="vecthare-textarea" rows="3" placeholder="Enter test messages, one per line..."></textarea>
                                        <div style="display:flex; gap:8px; margin-top:8px;">
                                            <button id="vecthare_wi_test_btn" class="vecthare-btn-secondary">Test Semantic WI</button>
                                            <button id="vecthare_wi_dump_registry" class="vecthare-btn-secondary">Dump Registry</button>
                                            <button id="vecthare_wi_apply_first" class="vecthare-btn-primary">Apply First Semantic Hit</button>
                                        </div>
                                    </div>

                                    <div style="margin-top:10px; display:flex; gap:12px; align-items:center;">
                                        <label class="checkbox_label" for="vecthare_enabled_for_all">
                                            <input id="vecthare_enabled_for_all" type="checkbox" />
                                            <span>Enabled for all entries</span>
                                        </label>
                                        <div style="flex:1"></div>
                                        <div style="width:160px;">
                                            <label for="vecthare_max_entries"><small>Max Entries</small></label>
                                            <input id="vecthare_max_entries" type="number" class="vecthare-input" min="1" max="9999" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Chat Auto-Sync Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-comments"></i>
                                </span>
                                Chat Auto-Sync
                            </h3>
                            <p class="vecthare-card-subtitle">Configure how chat messages are vectorized</p>
                        </div>
                        <div class="vecthare-card-body">

                            <label class="checkbox_label" for="vecthare_autosync_enabled">
                                <input type="checkbox" id="vecthare_autosync_enabled" />
                                <span>Enable Auto-Sync</span>
                            </label>
                            <small class="vecthare_hint">Automatically vectorize new chat messages</small>

                            <!-- Collection lock moved to Database Browser (per-collection settings) -->

                            <label for="vecthare_chunking_strategy" style="margin-top: 12px;">
                                <small>Chunking Strategy</small>
                            </label>
                            <select id="vecthare_chunking_strategy" class="vecthare-select">
                                <!-- Populated dynamically from content-types.js -->
                            </select>

                            <!-- Strategy description (populated dynamically) -->
                            <div id="vecthare_strategy_info" class="vecthare_hint" style="margin-top: 4px; margin-bottom: 12px;">
                                <span id="vecthare_strategy_description"></span>
                            </div>

                            <!-- Message Batch settings (only shown for message_batch strategy) -->
                            <div id="vecthare_batch_settings" style="display: none;">
                                <label for="vecthare_batch_size">
                                    <small>Messages per Batch: <span id="vecthare_batch_size_value">4</span></small>
                                </label>
                                <input type="range" id="vecthare_batch_size" class="vecthare-slider" min="2" max="10" step="1" />
                                <small class="vecthare_hint">How many messages to group together</small>
                            </div>

                        </div>
                    </div>

                    <!-- Actions Card -->
                    <div class="vecthare-card">
                        <div class="vecthare-card-header">
                            <h3 class="vecthare-card-title">
                                <span class="vecthare-icon">
                                    <i class="fa-solid fa-bolt"></i>
                                </span>
                                Actions
                            </h3>
                            <p class="vecthare-card-subtitle">Manage your vector database</p>
                        </div>
                        <div class="vecthare-card-body">

                            <div class="vecthare-actions-grid">
                                <button id="vecthare_vectorize_content" class="vecthare-action-btn vecthare-btn-primary vecthare-action-featured">
                                    <i class="fa-solid fa-plus-circle"></i>
                                    <span>Vectorize Content</span>
                                </button>
                                <button id="vecthare_vectorize_all" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-sync"></i>
                                    <span>Sync Chat</span>
                                </button>
                                <button id="vecthare_database_browser" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-folder-open"></i>
                                    <span>Database Browser</span>
                                </button>
                                <button id="vecthare_run_diagnostics" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-stethoscope"></i>
                                    <span>Diagnostics</span>
                                </button>
                                <button id="vecthare_view_results" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-bug"></i>
                                    <span>Debug Query</span>
                                </button>
                                <button id="vecthare_purge" class="vecthare-action-btn vecthare-btn-danger-outline">
                                    <i class="fa-solid fa-trash"></i>
                                    <span>Purge</span>
                                </button>
                                <button id="vecthare_text_cleaning" class="vecthare-action-btn vecthare-btn-secondary">
                                    <i class="fa-solid fa-broom"></i>
                                    <span>Text Cleaning</span>
                                </button>
                                ${getHealthIndicatorHtml()}
                            </div>

                            <label class="checkbox_label" for="vecthare_include_production_tests" style="margin-top: 20px;">
                                <input type="checkbox" id="vecthare_include_production_tests" />
                                <span>Include Production Tests</span>
                            </label>
                            <small class="vecthare_hint">Tests actual embedding generation, storage, and retrieval (slower but thorough)</small>

                            <label for="vecthare_log_level" style="margin-top: 12px;">
                                <small>Console Log Level</small>
                            </label>
                            <select id="vecthare_log_level" class="vecthare-select">
                                <option value="error">Errors only</option>
                                <option value="warn">Warnings</option>
                                <option value="info">Info (default)</option>
                                <option value="debug">Debug</option>
                                <option value="trace">Trace (very verbose)</option>
                            </select>
                            <small class="vecthare_hint">How much VectHare writes to the browser console. Use Debug when reporting a problem.</small>

                        </div>
                    </div>

                </div>
            </div>
        </div>

        <!-- Diagnostics Modal -->
        <div id="vecthare_diagnostics_modal" class="vecthare-modal" style="display: none;">
            <div class="vecthare-modal-overlay"></div>
            <div class="vecthare-modal-content vecthare-diagnostics-modal">
                <div class="vecthare-modal-header">
                    <h3>
                        <i class="fa-solid fa-stethoscope"></i>
                        <span id="vecthare_diagnostics_title">Run Diagnostics</span>
                    </h3>
                    <button class="vecthare-modal-close" id="vecthare_diagnostics_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-modal-body">
                    <!-- Phase 1: Category Selection -->
                    <div id="vecthare_diagnostics_selection" class="vecthare-diagnostics-phase">
                        <p class="vecthare-diagnostics-intro">Select which diagnostic categories to run:</p>

                        <div class="vecthare-diagnostics-categories">
                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_infrastructure" checked>
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-server"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Infrastructure</strong>
                                        <span>Backend connections, plugins, API endpoints</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_configuration" checked>
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-sliders"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Configuration</strong>
                                        <span>Settings validation, chunk size, thresholds</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_visualizer" checked>
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-eye"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Visualizer</strong>
                                        <span>Chunk editing, deletion, summary vectors</span>
                                    </div>
                                </div>
                            </label>

                            <label class="vecthare-diagnostics-category-option">
                                <input type="checkbox" id="vecthare_diag_production">
                                <div class="vecthare-diagnostics-category-card">
                                    <i class="fa-solid fa-vial"></i>
                                    <div class="vecthare-diagnostics-category-info">
                                        <strong>Production Tests</strong>
                                        <span>Live embedding, storage, retrieval tests</span>
                                    </div>
                                </div>
                            </label>
                        </div>

                        <div class="vecthare-diagnostics-actions">
                            <button class="vecthare-btn-secondary" id="vecthare_diag_cancel">Cancel</button>
                            <button class="vecthare-btn-primary" id="vecthare_diag_run">
                                <i class="fa-solid fa-play"></i> Run Diagnostics
                            </button>
                        </div>
                    </div>

                    <!-- Phase 2: Running -->
                    <div id="vecthare_diagnostics_running" class="vecthare-diagnostics-phase" style="display: none;">
                        <div class="vecthare-diagnostics-spinner">
                            <i class="fa-solid fa-spinner fa-spin"></i>
                            <span>Running diagnostics...</span>
                        </div>
                    </div>

                    <!-- Phase 3: Results -->
                    <div id="vecthare_diagnostics_results" class="vecthare-diagnostics-phase" style="display: none;">
                        <div id="vecthare_diagnostics_content"></div>
                        <div class="vecthare-diagnostics-footer">
                            <button class="vecthare-btn-secondary" id="vecthare_diag_back">
                                <i class="fa-solid fa-arrow-left"></i> Run Again
                            </button>
                            <button class="vecthare-btn-secondary" id="vecthare_diag_copy">
                                <i class="fa-solid fa-copy"></i> Copy Report
                            </button>
                            <button class="vecthare-btn-danger" id="vecthare_diag_fix_all" style="display: none;">
                                <i class="fa-solid fa-wand-magic-sparkles"></i> Fix All Issues
                            </button>
                            <button class="vecthare-btn-primary" id="vecthare_diag_done">Done</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <!-- Chunk Visualizer Modal -->
        <div id="vecthare_visualizer_modal" class="vecthare-modal" style="display: none;">
            <div class="vecthare-modal-overlay"></div>
            <div class="vecthare-modal-content vecthare-visualizer-content">
                <div class="vecthare-modal-header">
                    <h3>
                        <i class="fa-solid fa-cubes"></i>
                        Chunk Visualizer
                    </h3>
                    <button class="vecthare-modal-close" id="vecthare_visualizer_close">
                        <i class="fa-solid fa-times"></i>
                    </button>
                </div>
                <div class="vecthare-visualizer-toolbar">
                    <input type="text" id="vecthare_visualizer_search"
                           class="vecthare-visualizer-search"
                           placeholder="Search chunks by text, keywords, or name...">
                    <div class="vecthare-visualizer-stats">
                        <span id="vecthare_visualizer_count">0 chunks</span>
                        <span id="vecthare_visualizer_tiers"></span>
                    </div>
                </div>
                <div class="vecthare-modal-body">
                    <div id="vecthare_visualizer_content"></div>
                </div>
                <div class="vecthare-modal-footer">
                    <button class="vecthare-btn-secondary" id="vecthare_visualizer_done">Done</button>
                </div>
            </div>
        </div>

        ${getHealthModalHtml()}
    `;
}
