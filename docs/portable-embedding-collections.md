# Portable embedding collections

Use **Database Browser → Embedding Provider / Migrate** for a single collection.
Inference servers (KoboldCpp, llama.cpp, compatible local OpenAI servers) and vector
storage (Standard/Vectra, LanceDB, Qdrant, Milvus) are separate choices. A saved
physical locator contains backend, source namespace, model namespace and collection
ID. A compatible inference switch retains that locator. Queries, hashes/counts,
inserts, deletes, exports, metadata operations, hybrid search and auto-sync resolve
the collection's saved settings rather than routing through the global provider.
Ambiguous bare IDs are rejected; select the qualified collection instead.

## Compatible inference switching

The dialog previews **compatible**, **incompatible**, or **unknown**, with reasons.
Neither 768 dimensions nor matching filenames establish an embedding space.
Compatibility needs a complete versioned fingerprint recorded for the **stored
vectors**, covering artifact hash/revision, dimension, pooling, normalization,
document/query prefixes and task modes, tokenizer, truncation, context length,
distance metric and text cleaning. `textCleaning` is `none` or
`strip-markdown-html`. Empty query/document prefixes are valid deliberate values.
Other missing values remain unknown. Existing fingerprints without text-cleaning
provenance remain unknown even if their other version-1 fields match.

**Test synthetic probes** contacts only the explicitly configured candidate URL.
Both fixed public document and query probes must match historical probes saved
with the original fingerprint within `1e-5` maximum component error. Comparing two
currently loaded servers cannot certify unknown historical vectors. The dialog
has no force-compatible override. A matching result enables the final explicit
inference-switch confirmation; this saves the new profile and previous connection.
Restore the previous connection through the same dialog.

The client supports indexed OpenAI-compatible `/v1/embeddings` responses, strict
batch alignment, finite nonzero vectors and consistent dimensions. It applies
mode-specific prefixes and optional text cleaning. Pooling, tokenization, task
configuration, normalization, truncation and context must be configured correctly
on the inference server; the client does not invent server-specific request fields
or approximate token truncation with character slicing. KoboldCpp's existing
HTML/Markdown cleaning and `/v1/embeddings` request behavior are preserved.

Saved profiles recheck **both public probes before each private-text request**.
Changing the model at the same endpoint, even under a generic reported model name,
therefore fails closed. A saved reported model label is also checked. Endpoint
URLs must be absolute HTTP(S), without embedded credentials, query strings or
fragments. Browser CORS and HTTPS mixed-content restrictions apply. Redirects,
cookies and automatic fallback to another server/cloud service are disabled.
Transient HTTP 429/502/503/504 inference failures retry the same endpoint; timeout,
invalid output and compatibility errors remain visible. Runtime-only credentials
may be supplied with `local_embedding_api_key`; fingerprints, saved collection
profiles and exports never include that key. Credential storage UI is not added.

## Different models or unknown provenance

Choose a complete target fingerprint and a new target ID, then explicitly confirm
**rebuild to new collection**. The confirmation identifies the destination endpoint
and model because all original chunk texts will be sent there. Rebuilding requires
the Similharity plugin's complete text/metadata/vector listing and collection
inventory. Counts and hashes are paginated; incomplete text, duplicate identifiers,
unsafe IDs and existing targets stop the operation. An original KoboldCpp index
can be rebuilt using a different local model such as EmbeddingGemma; it does not
need compatible source provenance because its stored vectors are not reused.

Source and target writes are paused in this VectHare session, and in-flight writes
are drained before the snapshot. Original queries remain usable. Text, stable
hashes, ordering, activation settings, temporal/conditional metadata, locks, groups
and collection preferences are copied. The new index stays disabled while batches
are embedded/written. There is no ambiguous retry of backend writes: a failed or
cancelled build cleans up its new target, and a restart uses a new ID. An interrupted
browser session or failed cleanup leaves a disabled `building`/`cleanup-required`
target; never enable it. Delete that target explicitly or restart with a new ID.
Discovery/metadata cleanup preserves migration state, and activation guards reject
unfinished targets.

Before marking the target ready, VectHare verifies complete count/identifiers,
exact text and ordering, preserved metadata and stored vector values. It compares
three representative target query rankings against exact cosine scores of the
newly generated vectors, allowing boundary ties. Automatic ranking verification
currently requires cosine distance. This checks storage/query plumbing; it does
not measure real-world retrieval quality after a model change. Compare your own
representative queries before selecting **activation switch**.

Activation switch is a second explicit action: it enables the verified target,
pauses the original, and replaces qualified chat-policy selections. Rollback
restores source activation/auto-sync and policy selections and disables the target.
Neither switch deletes either collection. Rebuilt collections are static snapshots;
auto-sync remains off on the target. Coordinate other browser tabs, devices and
external writers during rebuilding: the current server contracts provide neither
cross-client snapshot isolation nor atomic target reservation. Session write guards
cannot control external clients.

## Restoring a JSON backup safely

Database Browser import always creates a **new disabled copy** with a generated ID.
It never overwrites or purges the backup's original destination. Complete saved
fingerprints and probes are required to reuse vectors; otherwise the backup must
contain recoverable text and is re-embedded with the currently selected provider.
Disk/settings collisions are rejected, unfinished/failed copies remain disabled,
and complete count/identifiers are verified before a copy can be enabled. Inspect
the reported destination and chunks, then enable it explicitly. Keep the JSON
backup unchanged. Shared Milvus/Qdrant multitenancy imports are blocked because
this restore path requires a separate physical index.

For a native SillyTavern instance with text generation on port 9931 and a separate
llama.cpp embedding server on port 5001, choose llama.cpp in VectHare, enable
**Use Alternative Endpoint**, and set `http://127.0.0.1:5001`. Plugin insert/query
requests now receive that explicit URL instead of falling back to localhost:8080.
Do not point the text-generation connection at the embedding server. A responding
`/v1/models` route confirms reachability, not successful embedding generation;
verify the import and its final count before activation. If the original collection
has been deleted, restore from JSON rather than using the migration action, which
needs a live source collection.

For Qdrant, LanceDB and Milvus, leaving the llama.cpp endpoint unconfigured keeps
the companion plugin's server-side default. A browser does not need its own
llama.cpp text-generation connection to use that default. Explicit alternate
endpoints still take precedence and cannot be blank. Qdrant's `localhost` host is
resolved by the SillyTavern server, including when accessing it from a phone.

Hybrid search forwards the configured embedding endpoint to both native hybrid
queries and vector queries used for client-side fusion. A populated browser-local
keyword index can mask an embedding connection failure by supplying lexical
results; a fresh browser may have no such index. If inference fails and no lexical
candidates are available, Search Debug reports the underlying error.

## Explicit BM25 fallback

The dialog can read all stored chunk texts and build a complete BM25 index without
contacting any inference endpoint, then persist lexical-only retrieval for this
collection. Coverage is checked against the complete physical storage hash list on
each query, using storage-only adapters that skip inference-dependent backend
initialization. Incomplete coverage produces a visible error rather than partial
memory. Rebuild the lexical index after external edits. Results carry `bm25Score`
and `retrievalMode: "lexical-only"`, with no dense similarity score. Existing hybrid
search remains available; precomputed-vector hybrid paths use client fusion instead
of native hybrid routes that would regenerate embeddings server-side.

## Exact server/API boundaries

Contracts inspected:

- [SillyTavern native vectors](https://github.com/SillyTavern/SillyTavern/blob/release/src/endpoints/vectors.js):
  `/api/vector/insert`, `/query`, `/query-multi` consume `embeddings[text]` only for
  `source: "koboldcpp"` and `"webllm"`. A llama.cpp client can therefore query/append
  an existing native KoboldCpp namespace without moving it. For other native
  sources, merely including `embeddings` is insufficient: the server ignores it
  and regenerates vectors. Such requests are blocked unless the plugin path is
  available. The native `/purge` deletes every source/model namespace for that ID;
  VectHare now purges only the addressed hashes when using native APIs.
- [Similharity routes](https://github.com/Coneja-Chibi/VectHare/blob/Similharity-Plugin/index.js):
  `/chunks/insert` accepts `items[].vector`; `/chunks/query` accepts `queryVector`
  independently of `backend`, `collectionId`, `source` and `model`. Standard uses
  those routes for precomputed queries when the plugin is available. LanceDB and
  Milvus now carry query vectors too. Plugin `/chunks/purge` preserves namespace
  scoping. Standard rebuild targets use a distinct `webllm` storage namespace;
  the inference profile can still be llama.cpp or KoboldCpp.
- The plugin's `/chunks/:hash/text` regenerates vectors server-side and may change
  hashes. `/chunks/insert` does not provide an atomic replacement by stable hash
  for Vectra. **Client-generated text edits are blocked before mutation.** To change
  their text safely, rebuild a distinct collection. The precise upstream fix is
  an atomic PATCH accepting a validated precomputed vector with storage locator,
  preserving the existing item ID, hash and all untouched metadata, with explicit
  opt-in hash changes. Until that exists, adding an ignored vector to PATCH or
  delete-then-insert is not advertised as a safe edit.
- Native non-KoboldCpp/WebLLM inference switching without Similharity would require
  `getSourceSettings` and both `getVector`/`getBatchVector` to consume validated
  precomputed vectors while retaining storage source/model scoping. Native list,
  delete and purge must honor that independent locator as well.
- Milvus currently uses shared `vecthare_main`; a distinct physical migration
  target requires an upstream adapter/server change. Rebuild is blocked there.
  Qdrant multitenancy is likewise blocked for rebuilding because it uses a shared
  physical index. Separate Qdrant collections and LanceDB targets retain their
  adapters' physical naming rules; supplying a model field does not create a new
  server namespace where that backend's implementation does not support one.

No other repository was modified, no server capability was assumed, and no user
conversation or live collection was accessed or migrated.

## Manual KoboldCpp → llama.cpp checklist

1. Back up settings and the physical vector index. Keep the original server and
   collection usable. Record physical source/model/ID, complete counts, and several
   representative query rankings. Coordinate other writers and tabs.
2. Obtain trustworthy **historical** artifact/revision and preprocessing records,
   including saved public document/query probes. Do not fill historical source
   provenance from the model loaded today. Missing records require a text rebuild.
3. Configure llama.cpp with embeddings enabled, the correct pooling/context/tokenizer,
   and the identical model artifact and task/prefix/normalization behavior. Enable
   browser access/CORS only for your intended local client. Check its explicit URL.
4. Preview and test in the collection dialog. Switch inference only after a compatible
   result. Verify query/insert/delete/export/count still address the original locator.
   Client-side text editing currently needs the upstream atomic PATCH described above.
5. Load a different model at the same URL and confirm a request fails before sending
   private text. Restore the original model/connection and test again.
6. For unknown provenance or a different model, rebuild to a new disabled target.
   Inspect metadata, counts, sample chunk contents, lexical coverage and representative
   rankings. Test cancellation/clean restart with a separate synthetic collection.
7. Explicitly switch activation, then roll back and verify original queries and policy
   selections. Leave the original on disk until a separate deletion decision.

Automated tests use synthetic vectors and mocked HTTP/storage contracts, including
an integrated inference/storage/rebuild path and DOM state tests. They are not a
live KoboldCpp/llama.cpp migration or evidence of model compatibility on your machine.
