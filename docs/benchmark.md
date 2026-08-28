# Retrieval benchmark

## Corpus

The initial regression corpus is the frozen Pi history created on
2026-08-27 for the Recall comparison:

- 623 JSONL files, including raw subagent artifacts
- 528 valid Pi sessions discovered after excluding `subagent-artifacts/`
- 9,023 visible user, assistant, and system messages
- 40 deterministic rare-term known-item queries

## Session Search 0.1 result

| Metric | Session Search | Hermes snapshot | Required gate |
|---|---:|---:|---:|
| Rank@1 | 92.5% | 87.5% | at least 87.5% |
| Recall@5 | 100% | 100% | 100% |
| Recall@10 | 100% | 100% | 100% |
| MRR | 0.9521 | 0.9271 | informational |
| Misses | 0 | 0 | 0 |
| Persistent-engine p95 | 1.16 ms | 0.71 ms | at most 1.5 ms |
| Index size | 41.8 MiB | 21 MiB | at most 50 MiB |

Session Search rebuilt from the complete valid JSONL corpus. The frozen Hermes
database contained 532 sessions but only 6,581 indexed messages, so its size and
latency are not directly comparable to the fresh 9,023-message index. The new
index covers nested Pi forks and managed child sessions while excluding raw
subagent transcript artifacts.

The machine-readable local result is generated with:

```bash
npm run benchmark -- \
  --sessions <PI_SESSIONS_DIR> \
  --queries <QUERIES_JSON> \
  --storage <TEMP_STORAGE_DIR> \
  --output <RESULT_JSON> \
  --gate
```

## Interpretation

This benchmark establishes lexical known-item retrieval and persistent-engine
latency. It does not establish semantic or cross-lingual retrieval. Those need a
separately judged dataset and, if strict paraphrase retrieval is required, a
ranking layer beyond FTS5.

## Semantic and multilingual benchmark

A private local benchmark contains 30 manually judged cases:

- 10 English paraphrases over English sources
- 10 Spanish paraphrases over Spanish sources
- 5 Spanish queries over English sources
- 5 English queries over Spanish sources

The source dataset is intentionally excluded from the public repository because
it contains excerpts and identifiers from private local conversations. The
benchmark runner requires an explicit external `--dataset <file>` argument.

```bash
npm run benchmark:semantic -- \
  --sessions <PI_SESSIONS_DIR> \
  --dataset <PRIVATE_DATASET_JSON> \
  --storage <TEMP_STORAGE_DIR> \
  --output <RESULT_JSON>
```

The original broad fallback sorted every partial match by recency. It retrieved
none of the 30 expected sessions in the first ten unique results. Ranking broad
FTS5 OR fallback results with BM25, while preserving recency for exact AND
matches, produced:

| Category | Rank@1 | Recall@5 | Recall@10 | MRR | Misses |
|---|---:|---:|---:|---:|---:|
| English paraphrase | 40% | 70% | 80% | 0.4883 | 2/10 |
| Spanish paraphrase | 80% | 90% | 90% | 0.8500 | 1/10 |
| Spanish query to English source | 0% | 0% | 0% | 0 | 5/5 |
| English query to Spanish source | 60% | 80% | 80% | 0.7000 | 1/5 |
| Overall | 50% | 66.7% | 70% | 0.5628 | 9/30 |

The apparent English-to-Spanish cross-lingual success comes from shared proper
names, file names, and English technical vocabulary inside Spanish sessions. It
is not evidence of translation or general cross-lingual understanding.

### Agent-supplied bilingual expansion

The ten cross-lingual cases also include one manually authored source-language
variant. `session_search` searches up to three variants before the original
query, interleaves each ranked list, and deduplicates by session. It performs no
translation or additional model call.

| Category | Rank@1 | Recall@5 | Recall@10 | MRR | Misses |
|---|---:|---:|---:|---:|---:|
| English paraphrase | 40% | 70% | 80% | 0.4883 | 2/10 |
| Spanish paraphrase | 80% | 90% | 90% | 0.8500 | 1/10 |
| Spanish query to English source | 100% | 100% | 100% | 1.0000 | 0/5 |
| English query to Spanish source | 100% | 100% | 100% | 1.0000 | 0/5 |
| Overall | 73.3% | 86.7% | 90% | 0.7794 | 3/30 |

These cross-lingual numbers are an upper-bound test of retrieval after a good
translation, not a benchmark of automatic translation quality. In normal use,
the already-active agent supplies the variants as part of its tool call.

### Decision

- BM25 is retained for broad fallback because it materially improves
  same-language paraphrase retrieval without changing exact known-item metrics.
- Session Search remains a lexical FTS5 product. It must not claim general
  semantic retrieval or built-in translation.
- Agent-supplied bilingual expansion is retained because it closes the tested
  cross-lingual gap without another model, index, or network dependency.
- A multilingual vector index is not justified by the current benchmark.
