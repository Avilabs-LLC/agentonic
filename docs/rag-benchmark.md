# Retrieval benchmark and re-ranking

Implemented 18 September 2026. This document distinguishes implementation, synthetic evidence and deployment. No live VM installation or database migration is performed by the benchmark.

## Retrieval behavior

All three execution paths—knowledge preview, frozen agent preview/evaluation, and deployed private chat—use the shared worker pipeline. With `AGENTONIC_RERANK_ENABLED=true`:

1. The database checks current authorization and materializes eligible active document versions before ranking.
2. Up to 40 semantic and 40 multilingual full-text results are fused with reciprocal rank fusion (`k=60`). The top 32 become candidates.
3. The worker removes exact duplicate text, preserving the first hybrid-ranked citation ID. Different facts and near-duplicates remain distinct.
4. Voyage `rerank-2.5-lite` ranks those passages against the retrieval query, including the existing bounded follow-up context. Profile `hybrid40-rrf60-candidates32-rerank2.5lite-preserve8-v2` protects every distinct passage in the original hybrid top eight. Only slots freed by exact duplicates can take additional reranked candidates. The chosen passages are then ordered by the model, with hybrid order breaking ties. Provider-supplied text and IDs are never accepted.

   This guarantees preservation of the baseline's distinct evidence within the same eight-passage context. When the original eight are all unique, this is reordering only; it cannot recover a missing ninth passage. It guarantees context coverage, not that the answer model will use every passage correctly.
5. Selection is validated against the original candidates, and permissions, active versions and the lease are checked again. The answer model cannot read a context with more than eight passages.

The model receives only authorized candidates, with another database check immediately before the provider request. Revocation/deletion during that request prevents subsequent publication; text already sent cannot be recalled. Empty or single-distinct-passage retrieval skips the reranker. Model scores are not treated as confidence probabilities, and no uncalibrated score threshold discards evidence. Missing evidence still requires the existing answer model's explicit abstention.

The fixed embedding model (`voyage-4`, 1,024 dimensions) and `sections-v1` chunker remain unchanged, so no document reindex is required.

## Budget and failure behavior

Re-ranking uses the existing Voyage budget and per-preview/evaluation/deployment accounting. The worker reserves a conservative byte-based token ceiling, charges the query once per candidate, and settles reported usage. The implementation uses the published $0.02 per million processed tokens without assuming free credits. Provider request timeout is 15 seconds, and input has fixed candidate/byte limits. See [Voyage's request contract](https://docs.voyageai.com/reference/reranker-api) and [pricing](https://docs.voyageai.com/docs/pricing).

A denied reservation makes no provider call. Invalid rankings with valid usage still settle that usage. A timeout, invalid usage or unknown provider outcome retains its reservation and fails that attempt; there is no silent hybrid fallback and no provider retry inside the reranker. Existing job retry policy still applies to knowledge jobs, and every attempt must reserve again. Evaluations and deployed turns fail visibly. Selection cannot finalize while the job has unresolved reservations. This is deliberately conservative: an ambiguous provider charge requires operational reconciliation, never a fabricated zero-cost settlement.

## Running the benchmark

Use Node 22 and the repository's installed dependencies:

```sh
pnpm rag:benchmark
pnpm rag:benchmark --live
pnpm rag:benchmark --live --answers
pnpm rag:benchmark --original --live --answers
```

The default is an offline SQL/metrics diagnostic using token-hash vectors. **Those results do not establish semantic retrieval quality.** The `--live` modes call Voyage; `--answers` also calls OpenAI using the shared grounded knowledge-answer implementation. Keys are read from the worker's ignored local environment or process environment. No Supabase credentials, customer uploads, VM connection or real customer records are used.

Each invocation creates a fresh PGlite database with the actual checked-in migrations and restricted roles. The corpus is ingested through the actual publication SQL and production chunker. Both live modes share the same batched real document/query embeddings. Requests are paced for low-tier Voyage limits; the run can take several minutes. It stops on provider failure and does not retry uncertain requests.

The per-invocation reservation cap is **$0.25 across both providers**. Content-free usage, including unknown reservations, is written after every accounting operation under `.local/rag-benchmark/<timestamp>/usage.json`. A failed run retains that file. A new invocation has its own cap; account for previous invocations separately. Completed reports are written beside it. No generated answer text or credentials appear in those reports. Synthetic answers are kept separately in an ignored local `synthetic-answers.json` file for manual review; they never come from customer documents.

The default follow-up dataset (`synthetic-coverage-v2`) contains 52 documents and 16 questions: two existing regression cases, six new development questions and eight fresh held-out questions. It emphasizes two- and four-source comparisons, contrasting exclusions, similar maintenance intervals, multiple numerical facts and unavailable/restricted evidence. The selection rule was fixed before running these questions. The original dataset remains available with `--original`: 41 documents and 21 questions (nine development, twelve formerly held-out). Those original questions have already been inspected and are regression evidence for v2, not a new holdout. Exact duplicates share one expected evidence identity. Separate database tests cover cross-workspace isolation, access revocation during processing and stale leases. The benchmark disposes of completed local fixture jobs between questions instead of changing the application's user rate limit.

## Reading the report

Reports preserve the corpus hash, implementation file hashes, Git revision/dirty state, chunker, embedding/reranking/answer model names and per-question results. Compare development and held-out sets separately:

- Hit@8, recall@8, MRR@8 and nDCG@8 evaluate expected evidence identities. Duplicate evidence never earns repeated credit and still consumes rank positions. No-evidence questions are excluded from these metrics, not scored as perfect retrieval.
- Candidate recall@32 distinguishes retrieval misses from reranker mistakes. Baseline evidence retention is checked per question, not just on average.
- Live runs fail their quality gate on excluded evidence, loss of baseline evidence/recall, or an expected-fact completeness regression relative to the paired baseline. These gates report the result; they do not enable workers automatically.
- Duplicate counts and excluded passage counts measure diversity and authorization leakage. Any excluded passage fails the benchmark.
- Citation precision checks expected source membership; fact matching checks explicit synthetic expected facts; no-evidence abstention and unsupported-answer rates are reported separately. These automated checks are **proxies**, not semantic entailment judgments or proof that every answer is correct.
- p50/p95 latency excludes deliberate pacing but includes database, network and answer generation when enabled. Shared embedding setup is included in total cost, not per-mode answer cost/latency. This is one sample per question/mode on a local test database, not a production latency SLO or concurrency test.

## Rollout

Re-ranking is implemented but **disabled by default**. The new migration preserves the original eight-passage search for existing workers.

1. Review the measured report below and approve the retrieval profile for the target environment. Extend the held-out corpus with explicitly authorized domain examples before making a customer-quality claim.
2. Apply forward migration `202609180028_reranking` to the explicitly configured nonproduction database through the normal migration command. Never edit applied migrations.
3. Set `AGENTONIC_RERANK_ENABLED=true` consistently for ingestion/preview, evaluator and staging broker. The evaluator and staging installation scripts copy this setting from the worker configuration. Package new immutable artifacts and perform the normal installation/verification; changing local source does not update the VM.
4. Re-evaluate the target frozen agent and its approval against the new retrieval behavior before activation. Verify candidate access, budgets, citations, revocation and error presentation with synthetic resources first.
5. Rollback behavior by disabling the setting consistently and reinstalling/reverifying the intended artifacts. Keep the forward migration and accumulated usage. Never silently mix evaluated and deployed retrieval profiles.

Changing existing VM services or enabling this mode requires a separate controlled rollout. That rollout was explicitly authorized and completed on 18 September 2026; the benchmark itself does not modify VM services.

### Completed nonproduction rollout — 18 September 2026

The [content-free installation receipt](benchmarks/rag-rollout-2026-09-18.json) records installed artifact hashes, verification timestamps, usage and cleanup. Migration 28 is applied. The local knowledge/preview worker, local staging broker and Azure evaluator/staging broker now use the coverage-preserving v2 profile with re-ranking enabled. The local evaluator configuration is also refreshed; Azure supplied the live evaluation evidence. `agentonic-runtime` was neither edited nor rebuilt.

Live checks passed for private ingestion, cited preview answers, abstention, workspace isolation, deletion, six Azure evaluation cases, automatic policy approval, local and Azure deployed chat, and recovery after restarting the synthetic VM service. The checks confirmed paid reranker operations in each execution path, with settled usage. The synthetic review workspace consumed $0.011151 across ingestion, preparation, evaluation and the two chats; this excludes the separate preview smoke and benchmark runs. Its documents were purged, its deployments stopped and its workspace retired. No provider reservations remain unresolved in that workspace.

The original test deployment was stopped through the authorized lifecycle at the user's request. Its configuration and review history remain; chat content was scrubbed and its $0.004393 usage retained. It has not been reactivated: renew approval, complete evaluation, authorize test use and activate a new deployment through the normal flow. This prevents an old evaluation from silently becoming evidence for the new retrieval behavior.

All 329 automated tests, typecheck, lint, Prisma generation/validation and 15 skeleton baselines passed. Knowledge/preview and local staging are still development processes on the Mac; the VM runs the evaluator and staging controller. This rollout does not deploy the web apps/ingestion to the VM, establish production readiness, or demonstrate 500-agent capacity. At deployment time, the source changes were in the local `agentonic` working tree; immutable worker package manifests captured their exact source hashes. The subsequent v0.9.0 branch release records that implementation in Git without rebuilding the installed artifacts.

### Installation and verification procedure

The implementation repository is **`agentonic`**, including `apps/worker/src/pipeline.ts` and `reranking.ts`. The frozen executable from the separate `agentonic-runtime` repository is reused unchanged. Updating the shared platform worker requires installing both the evaluator and staging broker; updating the runtime repository alone would not enable re-ranking.

- Finish active evaluations and stop active test deployments through the normal lifecycle before installation. The staging installer refuses to replace a broker with queued, preparing or running deployments. A stop revokes that deployment's operating consent and scrubs its private chat content; it preserves configuration, decisions and usage. Obtain a fresh approval/operating consent through the customer flow before a new activation. Do not reset database statuses or budgets to bypass this boundary.
- Apply `pnpm db:migrate`, then set `AGENTONIC_RERANK_ENABLED=true` in the protected `apps/worker/.env.local`. Restart the local knowledge/preview worker. This setting is copied into the evaluator and broker configurations by the installation scripts; a `.env.example` edit has no operational effect.
- With the existing frozen runtime hash, run `node scripts/deploy-evaluation-staging.mjs --deploy --replace --runtime-sha256=<hash>`, then `node scripts/register-evaluation.mjs --replace`. Install the broker with `node scripts/install-staging.mjs --azure --runtime-sha256=<hash>`. Install the matching local broker with `--local --start` instead of `--azure` when local verification is required and its controller is not already running. Local evaluator configuration is refreshed during registration; run it only if local evaluation is needed.
- Run `node scripts/check-rag-live.mjs --live --rerank`, then `node scripts/check-review-flow-live.mjs --live --staging --rerank` sequentially. These are paid, bounded nonproduction checks. Both use a synthetic document with multiple distinct chunks, because a single candidate deliberately skips the reranking provider. The checks require settled `rerank-2.5-lite` usage for preview, Azure evaluation, and local/Azure deployed chat. They also cover citations, abstention, isolation, revocation, cleanup, runtime restart and retained usage. Interrupted review fixtures have a documented `--cleanup --staging` path in the same script.
- Check the installed hashes, protected configuration, service/host heartbeats and absence of unresolved synthetic jobs. Keep the content-free rollout receipt and immutable artifact manifests. Local workers are development processes; this operation does not deploy web apps or ingestion to the VM or make the platform independent of the Mac.

For this rollout, the local knowledge worker PID/log are in ignored `.local/rag-rollout-2026-09-18/knowledge-worker.{pid,log}`; the local staging controller PID remains `.local/staging/manager.pid`. Avoid starting duplicate local workers when resuming development. Protected local environment files retain the enabled setting for subsequent starts.

## Original pure-ranking result (v1)

**Decision: implement as opt-in; defer enabling pure re-ranking by default.** The existing hybrid retrieval remains the default because the measured reranker lost coverage on a multi-source question. No selection rule or model was tuned against the held-out results.

The [complete synthetic report](benchmarks/rag-2026-09-18.json) records 42 answer executions (21 questions × two modes), with $0.019496 of modeled provider usage including shared embeddings. Earlier setup attempts incurred $0.000178 of known usage and retained a $0.000069 uncertain reservation in ignored local accounting. Benchmark spending is tracked separately from customer workspace usage.

| Held-out metric | Hybrid baseline | Re-ranked |
| --- | ---: | ---: |
| Questions / answerable questions | 12 / 10 | 12 / 10 |
| Hit@8 | 100% | 100% |
| Recall@8 | 100% | 95% |
| MRR@8 | 0.950 | 1.000 |
| nDCG@8 | 0.965 | 0.961 |
| Expected-fact completeness proxy | 100% | 90% |
| Expected-source citation precision proxy | 100% | 95% |
| Correct abstention on no-evidence questions | 100% (2/2) | 100% (2/2) |
| Duplicate context passages, total | 5 | 0 |
| Excluded passages returned | 0 | 0 |
| Answer-path p50 / p95, pacing excluded | 1.34 / 3.10 s | 2.07 / 10.48 s |
| Held-out answer-path cost, shared embedding setup excluded | $0.005271 | $0.005866 |

Development-set retrieval and expected-fact checks were 100% for both modes. Candidate recall@32 was 100% for every answerable question. Across all questions, exact duplicate passages decreased from nine to zero. Both modes abstained on all four no-evidence/access-denied questions; no unanswerable question produced a supported-answer assertion in this sample.

**What failed:** the Brisa/Aurora comparison needs two warranty passages. Hybrid retrieved both. The reranker put Brisa first but filled subsequent slots with similar catalogue entries, dropping Aurora. The generated answer correctly declined to complete the comparison; it did not invent the missing warranty. This is a coverage regression, despite an improved first relevant rank. The cancellation answer also cited the returns policy, which the narrow expected-source labels did not include; its lower citation proxy is not by itself proof of an unsupported claim.

**Next evidence gate:** introduce a separate development set of comparison/contrast queries and evaluate a coverage-preserving hybrid/reranker blend or query decomposition. Keep this observed failure as a regression case, then create a new untouched held-out set. Require no recall/answer-completeness regression, no access leakage, and acceptable repeated latency/cost before default activation. Domain-representative, explicitly authorized cases remain necessary.

The initial measured run shared generated chunk UUIDs across its A/B modes. Subsequent benchmark-only hardening assigns stable synthetic IDs, starts fresh transactions between cases for long runs, and persists incremental progress. Two offline runs of that hardened harness returned identical evidence and ranking metrics. These changes do not turn the initial live observation into a replicated or statistically significant result.


## Coverage-preserving follow-up (v2)

The fixed policy protects the whole distinct baseline context instead of guessing which comparisons need two sources. It removes exact duplicates, fills only the resulting free slots, and uses the reranker to order the final evidence. It does not use gold labels, recognize benchmark product names, expand the context limit, or discard low-scoring protected evidence.

Tests exercise adversarial orderings and duplicate placements over 200 deterministic generated pools, plus the original Brisa/Aurora failure. Worker activation remains a controlled rollout using the unchanged permission, budget and lease checks.

**Decision: adopt v2 for a controlled nonproduction rollout.** The [follow-up live report](benchmarks/rag-coverage-2026-09-18.json) passed all four gates: access isolation, baseline evidence retention, per-question recall non-regression and paired expected-fact completeness. The fixed selection rule and fresh labels were not tuned after observing results.

The run used 52 synthetic documents and 16 questions × two modes (32 answers): two regression cases, six development cases and eight fresh held-out cases. Six of the held-out questions were answerable; two required abstention. Total modeled provider usage was **$0.016173**, including shared embeddings. All reservations settled.

| Fresh held-out metric | Hybrid baseline | Coverage-preserving re-ranking |
| --- | ---: | ---: |
| Hit@8 / recall@8 | 100% / 100% | 100% / 100% |
| Baseline distinct evidence retained | Reference | 100%, every question |
| MRR@8 | 1.000 | 1.000 |
| nDCG@8 | 0.987 | 1.000 |
| Expected-fact completeness proxy | 100% | 100% |
| Expected-source citation precision proxy | 100% | 100% |
| No-evidence abstention | 2/2 | 2/2 |
| Duplicate context passages, total | 2 | 0 |
| Excluded passages returned | 0 | 0 |
| Answer-path p50 / p95, pacing excluded | 1.625 / 2.134 s | 2.460 / 3.227 s |
| Answer-path cost, embedding setup excluded | $0.003799 | $0.004281 |

The measured extra cost was $0.00006025 per held-out question, and the median answer-path latency increased by 0.835 seconds. One sample per mode/question does not establish a production latency distribution; monitor these during the controlled rollout.

**Known regression fixed:** in the larger v2 corpus, the original Brisa/Aurora question placed its first relevant baseline passage third. V2 moved the first relevant passage to first while retaining the other warranty passage, answering “18 months versus 36 months” with both source citations. It preserved the other baseline evidence too. The development and held-out four-source comparisons retained and correctly used all four required passages.

A manual read of all eight reranked held-out answers confirmed the product/value associations, contrasting exclusions and two correct abstentions. The checks still have limits: response-language adherence was not graded, and English questions sometimes received Spanish answers. These results establish synthetic evidence quality, not general customer-domain accuracy or multilingual conversational certification.

The worker flag stays off until migration 28 and the matching immutable worker artifacts are installed consistently and verified. This implementation and benchmark do not change the running VM agent. A controlled rollout can now use the v2 profile; broad production enablement still needs representative domain evaluation and operational monitoring.
