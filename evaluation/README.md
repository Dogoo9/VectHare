# Retrieval evaluation

Run `npm run evaluate:retrieval [-- dataset.json]` to compare dense, lexical,
standard RRF, normalized weighted fusion, the legacy heuristic, and an optional
precomputed reranker. The checked-in fixture contains two deliberately different
datasets and graded relevance judgments. Replace it with production judgments
before making deployment-specific choices.

The harness reports Recall@3, MRR, nDCG@3, precision@3, sample variance and a
normal-approximation 95% confidence interval. Aggregate statistics treat datasets
as the sampling unit so one large/easy dataset cannot dominate. Fusion latency is
measured independently from backend and network latency over 200 iterations.

## Default decision

`evaluation/results.json` is the measurement captured before changing the fusion
default. All local methods tied on Recall@3 and precision@3. Among hybrid methods,
`heuristic_weighted` had the best MRR and nDCG@3 on both datasets, so it is the
fixture-selected default. The optional reranker scored best overall but is not a
default because it requires a separately supplied model/ranking. Re-run this
decision on representative production data: this small fixture demonstrates the
evaluation contract and is not evidence that one method wins universally.

RRF remains a standards-compliant, explicit option. Its score and order are only
the sum of `1 / (k + rank)` contributions; raw vector and lexical scores are
carried alongside it for display. The previous display-score heuristic is now the
separate `heuristic_weighted` option. Standard `weighted` uses candidate-set
min-max normalization and exposes both raw and normalized component scores.

Heuristic deployments can override any documented immutable default from
`HEURISTIC_WEIGHTED_DEFAULTS` with a `hybrid_heuristic_<snake_case_name>` setting.
