# Preview model selection

**Updated:** The original two-model preview experiment below has been extended by migrations 35–36. Preview and approved deployed chats now support model/effort configurations; see [model evaluations](model-evaluations.md). The original baseline and benchmark record below describe the earlier experiment.

Implemented on 19 September 2026 in the platform repository. Customer preview chat exposes GPT-4.1 mini (`gpt-4.1-mini-2025-04-14`) and GPT-6 Astra (`gpt-6-astra`) in a shared shadcn/Base UI radio menu. There is no automatic routing or fallback. Live Chats, deployed agents and automated evaluation retain GPT-4.1 mini.

The preview page opens only the latest prepared candidate; there is no historical version selector. Both “Probar agente” and “Iniciar prueba” explicitly enable that candidate’s frozen tools by default, including its configured Gmail and public-web permissions. Gmail writes still require confirmation of each exact action. Existing sessions keep their frozen execution policy and accumulated usage; reopening from the agent page selects or starts a session with the configured tools enabled. The interface keeps the spending ceiling and session controls concise.

The selection applies to the next message. Each queued turn records its model; its answer and provider operations record the same choice. Reloading resumes with the last turn's model. Switching preserves conversation history, tool consent, frozen knowledge/tool permissions, expiry and accumulated usage. The menu is disabled while sending or waiting. Retrying a request ID with a different model or question is rejected.

This is an explicit experimental **preview broker override**, not a mutation of the frozen runtime bundle or prepared version. The child runtime still validates its published prompt/configuration contract. The trusted preview broker obtains the selected model only from the leased database context, adapts the provider request and records the actual selected model on completion. Evaluation and staging contexts do not provide an override. A successful experimental preview does not change which model was reviewed or approved for deployment.

Migration 33 adds `background_jobs.response_model`, restricted to the baseline for ordinary retrieval and to the two-model allowlist for customer previews. Existing rows remain baseline. Customer identity/workspace verification, ownership, leases and live tool authorization remain required. Database reservations must match the queued model, and answers cannot be stored under another model. No customer role receives direct mutation privileges. Migration 34 allows a frontier request to reserve up to the US$3 session ceiling after several page reads; baseline calls retain their US$1 per-call ceiling. Both the remaining preview budget and global budget must still cover the reservation before a request is sent.

Preview start offers an explicit US$0.25 or US$3 ceiling; US$0.25 remains the default. The ceiling applies to the whole session and is not increased by changing models. Use US$3 when comparing frontier-model research. Existing previews retain their original ceiling. Global provider caps and existing reservations are preserved. These are limits, not charges or guarantees of ten completed messages.

## Provider compatibility and accounting

Astra uses Responses with low reasoning effort, 4,096 maximum output tokens (including reasoning), no temperature, and `store:false`. Returned encrypted reasoning items are preserved in memory between tool calls, never written to transcripts or logs. The baseline retains its existing temperature-zero/1,000-token contract. Both retain the same web policy, up-to-eight-call research allowance for research-capable runtimes and time limits. Legacy frozen runtimes still allow three calls.

Standard short-context list-price estimates are US$0.40/US$1.60 per million input/output tokens for mini and US$10/US$50 for Astra. Reasoning output is included in reported output usage. Cache discounts are not assumed. These are conservative operational estimates, not invoice amounts; provider cache-write or other tier pricing requires future detailed reconciliation. Unknown provider outcomes retain their reservations.

Sources checked on 19 September 2026: [Astra model/pricing](https://developers.openai.com/api/docs/models/gpt-6-astra), [migration parameters](https://developers.openai.com/api/docs/guides/latest-model). The configured API project's model listing included both identifiers. Astra currently has no dated snapshot in that listing; its alias is recorded explicitly. This preview experiment does not claim immutable upstream model weights.

## Repeatable comparisons

`node --import tsx scripts/model-benchmark/run.mjs --live` executes six paired cases using real metered OpenAI requests and identical synthetic Browserbase pages through the restricted preview/database/frozen-runtime path. No required answer prefix or grading instructions are supplied to the agent. Cases cover the owner's exact Madrid question, query refinement, follow-up constraints, hotel taxes/refundability, laptop specifications and unreadable/injected pages.

`--resume` skips recorded completed pairs. `--public` runs the exact Madrid request against actual Browserbase search/read for both models and writes a separate report. Live results are not identical controlled evidence: queries, search ranking and site availability may differ. Public evidence is retained only in ignored local files for inspection. No mailbox or customer knowledge content is used.

The harness requires an idle queue and exclusive access to its synthetic jobs. Pause the local knowledge worker only after checking for queued/running customer work, and always restart it afterwards. Start-rate limits are respected by waiting, never by clearing records or usage. Synthetic fixture rows are cleaned while immutable provider charges/reservations remain. Reports live under `.local/web/model-comparison*.json`. Synthetic web operations retain conservative ledger charges even though the Browserbase responses are intercepted; distinguish actual OpenAI estimates from these simulated web estimates.

Review answers independently for qualifying recommendations, contradictions, unknown-as-match errors, unnecessary early stopping, appropriate clarification, limitations and source support. A small synthetic suite is not a statistical guarantee or a housing-market benchmark. The recorded outcomes and decision are in `docs/model-comparison-2026-09-19.md`.
