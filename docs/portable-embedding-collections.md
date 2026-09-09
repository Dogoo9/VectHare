# Portable embedding collections

VectHare now treats a collection's physical locator separately from its embedding
connection. A locator contains the vector backend, source namespace, model
namespace, and collection ID. Reassigning a connection keeps that locator frozen,
so the original KoboldCPP `nomic-embed-text-v1.5.Q8_0.gguf` index is not moved,
renamed, overwritten, or deleted.

## Compatibility and reassignment

Compatibility has three states: **compatible**, **incompatible**, and **unknown**.
A versioned fingerprint covers artifact/revision identity, dimensions, pooling,
normalization, query/document prefixes and task modes, tokenizer, truncation,
maximum tokens, and distance metric. Names, provider labels, dimensions, URLs, and
currently loaded servers are not proof. Credentials are never fingerprinted or
exported. Quantization/runtime changes require both matching provenance and finite,
non-zero synthetic document and query probes within the conservative `1e-5`
maximum component tolerance. Probe agreement is evidence, not a guarantee.

Only `compatible` connections may append vectors. Unknown/incompatible collections
must be rebuilt from text into a distinct target. The rebuild helper writes in
batches, reports progress, supports `AbortSignal`, verifies the completed target,
and cleans up a partial target on cancellation/failure. The source remains usable;
switch-over is explicit and rollback means selecting its saved connection again.
Missing text and target-name collisions stop before writes.

Set `retrieval_mode: "lexical_only"` to use the existing complete BM25 index without
contacting an embedding endpoint. Results expose `retrievalMode: "lexical-only"`
and `bm25Score`; they deliberately do not present BM25 as vector similarity. Normal
collection activation happens before this mode in `queryActiveCollections`, and
the caller's existing `topK`/retrieval budget remains the result limit. Lexical
indexes are keyed by the complete physical locator to isolate same-name indexes.

## Companion-server boundary

SillyTavern's existing vector routes use `source` as the physical namespace and
normally also generate embeddings. Cross-provider reassignment is therefore safe
today only when VectHare can send a precomputed vector (currently WebLLM,
KoboldCPP, and BananaBread flows). Server-generated llama.cpp vectors cannot be
routed into/query a KoboldCPP namespace without a companion-server enhancement.
That enhancement should accept a precomputed query/document vector while retaining
an independently supplied, validated storage `source`/model namespace on the
existing vector operations. No new endpoint is assumed by this implementation.

## Local verification

1. Back up extension settings and keep the original collection enabled.
2. Record several representative query rankings against the original local
   KoboldCPP server.
3. Obtain trustworthy artifact/revision and preprocessing metadata for both local
   servers, then run the fixed synthetic document and query probes.
4. Reassign only after a compatible result; confirm counts, export, edit, insert,
   delete, and rankings still address the old locator.
5. For unknown/different results, rebuild to a new ID, verify chunk count/hashes and
   rankings, explicitly switch activation, then test rollback. Do not delete the
   original until separately approved.

Automated tests use mocks and synthetic vectors. Live KoboldCPP/llama.cpp model and
SillyTavern companion-server validation remains required; this repository has not
accessed or migrated user data.
