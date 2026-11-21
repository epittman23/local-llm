# Proposed Retrieval Evaluation

> **PROPOSED ONLY. NOTHING IN THIS DOCUMENT IS BUILT.**

| Field    | Value                                                                  |
| -------- | ---------------------------------------------------------------------- |
| Written  | 2026-11-21                                                             |
| State    | Proposed, not started                                                  |
| Related  | [proposed-inference-server.md](proposed-inference-server.md#retrieval-models) |

## Purpose

The Benchmarks pages measure the chat model on coding tasks. Nothing measures knowledge
retrieval: the embedding model, the reranker, hybrid search and the retrieval settings.
The only retrieval check so far is three queries on 2026-10-24
(`docs/guides/assistant-tools.md`), enough to confirm the setup works but not to compare
models. This proposal describes a repeatable test that can say whether a retrieval change
makes answers better, and what it costs in speed.

Priorities, from the owner: quality first, speed second. The decision rule below follows that
order.

## What is measured

Retrieval is scored in stages, so a result says which part of the pipeline helped or hurt.

| Stage                      | Question it answers                                    | Metrics                                              | Mainly reflects                    |
| -------------------------- | ------------------------------------------------------ | ---------------------------------------------------- | ---------------------------------- |
| 1. Vector search alone     | Does the embedding model find the right chunk?         | recall@k for k = 5, 10, 20, 50                       | Embedding model, chunking          |
| 2. Hybrid search           | Does adding keyword search find more?                  | recall@k as above                                    | Hybrid fusion, BM25 weight         |
| 3. After reranking         | Is the right chunk at the top of what the model sees?  | hit@kept, MRR, nDCG@kept                             | Reranker, `TOP_K`, `TOP_K_RERANKER` |
| 4. Unanswerable questions  | Does the pipeline admit it found nothing relevant?     | top reranker score distribution, false-hit rate at a threshold | Reranker calibration     |
| 5. End to end (secondary)  | Does the answer improve with the chat model held fixed? | answer correctness, citation correctness             | Everything above                   |
| Speed (every run)          | What does it cost?                                     | index time per 1,000 chunks; query latency p50 and p95 split into embed, search and rerank; peak VRAM | Model size, hardware |

Definitions:

- **recall@k**: share of questions whose relevant passage appears in the top k candidates.
- **hit@kept**: recall at the number of chunks actually put in the prompt (`TOP_K_RERANKER`).
- **MRR** (mean reciprocal rank): average of 1 / rank of the first relevant chunk; rewards
  putting it first.
- **nDCG@kept**: like MRR but credits every relevant chunk when a question has several.

Stages 1 to 4 need no chat model, so they are fast, cheap and deterministic. Stage 5 is
slower and noisier, and is run only for the final candidates.

## The test set

### Corpus

A frozen set of documents representative of real use: statistics and math notes, papers,
code files, data documentation. Two parts:

- **Public seed set** (committed, under `apps/server/local_llm/benchmarks/data/retrieval/`):
  a small corpus of openly licensed documents, so the test runs from a fresh clone and in CI.
- **Private set** (never committed, under `DATA_DIR`, which is already outside git): the
  owner's own documents. This is the set that decides model choices, since it is what the
  assistant actually retrieves from. Keeping it out of the repository follows the project's
  privacy goal.

### Questions

60-100 questions to start, each with a reference to the passage that answers it, spread over
categories that stress different weaknesses:

| Category        | Example                                                                 | Stresses                          |
| --------------- | ----------------------------------------------------------------------- | --------------------------------- |
| Paraphrase      | "compare before and after on the same people" for a paired t-test note  | Embedding semantics               |
| Exact term      | "what does `read_settings` return?"                                     | Keyword search, identifiers       |
| Code            | "where is the retry backoff configured?"                                | Code understanding                |
| Math notation   | "formula for the pooled variance"                                       | Notation in embeddings            |
| Multi-passage   | "which two functions write to the cache?"                               | Recall at larger k, `TOP_K_RERANKER` |
| Unanswerable    | a question the corpus does not cover                                    | Reranker calibration              |

### Labels that survive re-chunking

Chunk ids change whenever chunk size, overlap or the splitter changes, so labels must not
name chunks. Each question instead names the **document and the character span** of the
answer. A retrieved chunk counts as relevant if it overlaps that span by at least half of
the span's length (or half the chunk's, for spans longer than a chunk). This keeps one label
set valid across every chunking setting.

Questions can be drafted with help from a model, but every label is checked by hand: a
wrong label makes every comparison wrong.

## How a run works

1. Build a knowledge collection from the corpus with the configuration under test (embedding
   model, prefixes, chunk size and overlap). Record indexing time.
2. For each question, call the app's own retrieval functions (`retrieval/utils.py`'s
   `query_collection` and the hybrid path in `retrieval/vector/dbs/pgvector.py`), not a
   reimplementation, so the test measures the pipeline the assistant uses. Record each
   stage's ranked list, scores and timings.
3. Score stages 1 to 4 against the labels.
4. Optionally, for stage 5: send each answerable question with its retrieved chunks to one
   fixed chat model and grade the answer against a reference answer.
5. Store everything with a configuration fingerprint (embedding model and quantization,
   prefixes, reranker, `TOP_K`, `TOP_K_RERANKER`, BM25 weight, chunking, test-set sha), so
   rows from different configurations are never mixed. This mirrors how `config_id` works for
   serving runs.

Each configuration gets its own collection, since vectors from different embedding models
must never share an index.

## Comparing configurations

Every configuration answers the same questions, so comparisons are **paired**:

- Report each metric with a 95% bootstrap confidence interval, resampling questions.
- For hit@kept, use McNemar's test on the questions where the two configurations disagree.
- **Small samples detect only large effects.** With 80 questions, a difference of a few
  percentage points in hit@kept is within noise; the report says so instead of declaring a
  winner. More questions are the remedy, not more runs, since stages 1 to 4 are
  deterministic.

### Decision rule

A change is adopted when:

1. its hit@kept (or MRR, for reranker-only changes) beats the current configuration with a
   confidence interval that excludes zero, **and**
2. it does not lose more than an agreed margin on unanswerable questions, **and**
3. its p95 query latency stays within an agreed budget (proposed: no more than 1 s above
   the current configuration), and it fits the VRAM budget in the inference server proposal.

Quality decides first; speed only rules out a change, or breaks a tie between changes whose
quality is statistically indistinguishable.

## Order of experiments

Cheapest first, matching the inference server proposal's recommended order:

1. **Settings sweep, current models**: `TOP_K` in {5, 20, 50} × `TOP_K_RERANKER` in
   {3, 5, 8}, then chunk size in {500, 1000, 2000}. No new models.
2. **Rerankers**: `bge-reranker-v2-m3` against Qwen3-Reranker-0.6B and -4B, at the best
   settings. No re-indexing needed.
3. **Embedding models**, only if stage 1 recall is the bottleneck: `bge-m3` against
   Qwen3-Embedding-0.6B, and -4B truncated to ≤1,536 dimensions, each with its query prefix.
4. **End-to-end check** of the final two or three configurations with the deployed chat
   model.

Steps 1 and 2 can run on the laptop's CPU today, slowly, which also gives a baseline before
the server exists. Speed numbers from the laptop are not comparable with the server's and are
recorded with their hardware, per the maintenance policy.

## Implementation outline

Phased, so each step is useful on its own:

1. **Test set and runner.** Seed corpus and questions under `benchmarks/data/retrieval/`; a
   runner under `benchmarks/evaluation/` that builds collections, runs stages 1 to 4 and
   prints a report. pytest coverage on the seed set.
2. **Storage.** New `benchmark_retrieval_*` tables through an Alembic migration (the schema is
   append-only), keyed by the retrieval fingerprint.
3. **Interface.** A Benchmarks page to start runs and compare configurations, following the
   interface standard, beside Tests and Compare.
4. **Stage 5** end-to-end grading, reusing the Tests page's harness path where possible.

Documentation lands with each phase: `docs/guides/benchmarks.md`, `MAP.md`, the README's
"Pages and URLs" for the new page, and a `docs/decisions.md` entry when a configuration is
adopted.

## Open questions for the owner

1. **Private corpus contents.** Which documents best represent real use, and roughly how
   many? Do any need to stay out of even a local test (for example, other people's data)?
2. **Question authoring.** Write the questions by hand, or have a model draft them and check
   each one? Hand-written questions are more realistic; drafted ones are faster.
3. **Latency budget.** Is "+1 s at p95" the right tolerance for a quality gain?
4. **Stage 5 grading.** Grade end-to-end answers by hand, by reference-answer matching, or
   with a judge model? A judge model adds its own errors and should itself be spot-checked.
5. **Scope of phase 1.** Start with a runner only (results printed and kept as files), or
   build the database tables and page from the beginning?
