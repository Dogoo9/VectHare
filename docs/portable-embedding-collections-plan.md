# Portable embedding collections

## Goal and user constraint
Remove unnecessary embedding-provider lock-in without mixing incompatible vectors or losing existing collections. The user's working collection uses KoboldCPP with nomic-embed-text-v1.5.Q8_0.gguf. They want to move to another local embedding service such as llama.cpp. All embedding, probing, reindexing and inference data must remain on explicitly configured local/network endpoints; no cloud fallback, telemetry payloads, or uploading private chat data for testing. This is a coding handoff, not authorization to migrate the user's live data. Keep the PR draft and do not merge.

## Confirmed starting points (verify latest code)
- core/collection-ids.js parses backend:source:collectionId registry keys.
- core/collection-loader.js discovers and caches collections across embedding sources and storage backends, including model paths.
- backends/standard.js sends settings.source into vector storage/query requests, and supports precomputed query vectors. Source therefore participates in storage routing as well as embedding generation.
- core/collection-export.js validation requires source equality but treats a missing model as compatible in some paths; import has additional source/model checks.
- core/collection-metadata.js already has embedding provider/modelId/dimension/distanceMetric/indexVersion fields.
- core/core-vector-api.js generates client-side embeddings for some providers and shares query vectors in multi-query paths.
- core/hybrid-search.js and core/lexical-index.js already support independent lexical candidates and BM25/vector fusion.
Trace all paths rather than fixing only UI filtering or export validation. Check repo instructions and existing tests first.

## Required implementation
1. Separate logical collection identity, physical storage locator (backend/source/model namespace), embedding-space identity, and embedding connection/profile. Changing the embedding connection must not implicitly change where vectors are read, edited, counted, exported, or deleted. Preserve original locator and rollback configuration. Avoid collisions between same-named collections and legacy keys.
2. Add a per-collection UI action to inspect embedding compatibility and change the embedding connection. Show compatible, incompatible, and unknown states with practical explanations. Same provider is not proof of compatibility; changing model at the same URL must also be detected. Model filename, provider label, and dimension alone are insufficient.
3. Define a versioned embedding fingerprint: model/revision or trustworthy artifact identity when known, dimensions, pooling, normalization, document/query prefixes or task modes, relevant preprocessing/tokenization/truncation settings, and distance metric. Store no credentials in metadata or exports. Quantization/runtime differences require validation rather than assumptions of bit-identical output.
4. For known compatible models across servers, verify deterministic public/synthetic document and query probes with finite-vector/dimension checks and documented conservative tolerance. Label numerical probe agreement as evidence, not a mathematical guarantee. Check both query and document preprocessing. Do not certify legacy collections using two currently loaded servers unless their relationship to the stored vectors is established. Missing provenance must remain unknown and offer rebuild; no force-compatible switch based only on a name or dimension.
5. Once validated, generate query vectors through the selected connection while querying the original physical index. Group multi-collection queries only by a compatible embedding space/profile, and key caches by that identity. Cover single query, multi-query, hybrid search, automatic vectorization, insert/update, import/export, discovery, counts and deletion. Prevent new incompatible vectors from being appended.
6. Add a non-destructive rebuild to a NEW collection/index using recoverable original chunk text and the target embedding profile. Preserve IDs/hashes or remap references consistently, metadata, activation gates, locks, fusion settings, ordering, chunk groups, and lexical data. Keep old collection usable until the new index is complete and checked. Surface missing source text rather than silently skipping and claiming success. Provide progress/cancel and retry/resume or safe clean restart. Prevent auto-sync races and partial activation; enable explicit switch-over and rollback without automatic old-collection deletion.
7. For legacy imports distinguish unknown compatibility from verified compatibility. Do not import vectors as safe merely because model metadata is absent. Allow safe text rebuild while preserving source collection.
8. Offer an explicit lexical-only retrieval path using the existing complete lexical index when embeddings are unavailable/incompatible. It must operate without first calling the failing embedding service and retain activation/access/lock rules and retrieval token limits. Clearly show its mode and unavailable/incomplete lexical coverage. Verify lexical index isolation by full collection identity. Do not silently reinterpret BM25 scores as vector similarities.
9. Keep existing hybrid retrieval architecture; no new embedding model requirement, reranker, graph database, broad RAG rewrite or Summaryception modifications.

## Server/API boundaries
Inspect supported frontend and server contracts. Do not invent routes or pretend a frontend change can alter physical server namespaces. If a needed capability is absent, implement the supported safe path here and document the exact companion-server change needed. No changes to unrelated repositories or deployment of services. Use mocks and synthetic data for tests; never send the user's chat data to external APIs.

## Acceptance tests and evidence
Use existing Vitest conventions and add regression coverage for:
- KoboldCPP to llama.cpp compatible profile reuse preserving physical storage locator.
- Same dimensions but different model rejected; missing model/provenance unknown; same URL changed model detected; prefixes/pooling/normalization mismatch rejected; invalid/NaN/zero vectors handled.
- Mixed collections grouped correctly without reusing incompatible query vectors or leaking caches/lexical indexes.
- Full collection lifecycle after reassignment, including edits/inserts/deletes/export, not just query.
- Rebuild success, cancellation, partial failure, missing text, collision, stale async completion, retry and rollback preserving original collection and metadata.
- Legacy imports, registry migration and same-name collections across namespaces.
- Explicit lexical-only results when embedding endpoint fails, with no dense request, activation rules and budget preserved.
Run relevant existing tests and the retrieval evaluation fixtures. Report tests actually run and distinguish mocked integration from real KoboldCPP/llama.cpp/SillyTavern validation. Provide a concise local manual verification procedure, including comparing rankings before/after migration. Do not claim hardware/model compatibility without running it.

## Completion
Commit implementation and tests to this PR branch, update README and PR description with behavior and evidence, and keep draft for maintainer review. This brief may become final migration documentation once implementation is complete.
