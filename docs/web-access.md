# Public web access — Browserbase

**Release:** Agentonic 0.11.0 / runtime 0.3.0. The dated local checkpoints below are historical; see the VM release checkpoint for current installation details.

## Product decision

Owner-selected scope, 18 September 2026: search and read public websites. This is a platform-funded capability in **Configuración → Herramientas → Acceso web**, independent of **Conexiones**. Customers do not create Browserbase accounts, supply API keys or complete OAuth. Gmail remains a personal connection with separate operations.

The user selects Acceso web, saves the draft and prepares a version. That version freezes `web.search` and `web.read`. Private preview requires the existing explicit tools opt-in. Staging requires the usual reviewed version, operating consent and activation. Disabling web and saving the draft fences existing web-capable previews/deployments; enabling it again cannot add it to a version that never contained it. Existing no-tool sessions remain opted out.

## Implementation

- `packages/contracts/src/tools.ts` is the shared tool-grant union: at most one Gmail account and one web capability. Web has no fabricated connection ID.
- Migration `202609180031_web_access` validates the union, registers `web-v1` tools only for immutable code releases declaring `webContract: "1"`, writes the frozen tool index and checks current web permission.
- Existing Gmail authorization remains independent. Mixed web/Gmail grants preserve the Gmail account owner, live operations and per-write confirmation checks.
- `web_preview_worker` derives authority from a currently leased owner preview. `web_staging` validates the deployment service credential, current conversation/turn lease and operating authority. Staff, automated evaluations and ordinary retrieval jobs cannot call these tools.
- The broker invokes Browserbase's Search/Fetch SDK with its own protected API key. The child runtime and browser receive no provider credentials. No project ID or additional model gateway key is required for these APIs.
- Search returns up to five public source links; reading returns at most 16,000 characters. Search results alone are not evidence for page facts. New runtime releases declaring `webResearch: "1"` allow up to eight tool calls per turn, shared with Gmail (Gmail retains its own three-call maximum). The database enforces the immutable registry ceiling: eight for these new releases, three for earlier web releases. No existing registry or frozen configuration is rewritten. Research stops after 65 seconds, leaving a final-answer phase of up to 35 seconds inside the existing 110-second broker deadline. These are ceilings, not a requirement to spend every call. Runtime 0.7.0's batch turns (architecture §67) keep 8 web calls apart from Gmail's allowances, say to use the web only when a request needs public information, and show no remaining-calls note until the model has used it.
- Only public HTTPS destinations are accepted. Credentials in URLs, custom ports, IP literals, special/local names and private DNS answers are rejected. Redirect following, insecure TLS and proxies are disabled. Browserbase performs the fetch remotely; local DNS screening cannot pin Browserbase's own DNS resolution and is not a substitute for provider-side network isolation.
- No browser sessions, JavaScript rendering, website logins, persistent cookies, forms, attachments, purchases or external writes are provided. A page requiring these may fail; the agent must explain that limitation. A blocked, redirected, empty, unsupported or unavailable page becomes a structured tool result, allowing a different source within the remaining allowance. An identical failed request is not replayed. Rate/call/budget limits stop further tool use; loss of authorization still aborts execution.
- Web content is untrusted evidence. Runtime instructions prohibit treating it as permission or sending private Gmail/KB content or credentials in search queries/URLs. These instructions reduce prompt-injection risk but are not a formal data-loss prevention system; stronger source-aware outbound filtering is a future gate for sensitive deployments.
- Successful page reads append broker-observed URLs to the answer. Both preview and staging render a quiet source-link list. Web URLs never enter the knowledge-base passage UUID citation array. No automatic KB ingestion occurs.

## Usage and configuration

Browserbase has its own row in the existing provider ledger. Migration starts its cap at zero. `scripts/setup-web.mjs --cap-usd=1` copies `BROWSERBASE_API_KEY` from ignored `.env.staging.local` to the protected local worker environment and provisions a bounded nonproduction cap without resetting accumulated usage. The staging installer propagates the key only to trusted broker configuration when explicitly run. No key goes into a customer environment or public variable.

Each operation reserves usage before external access, against both its preview/deployment budget and the shared Browserbase cap. Conservative estimates use published overage rates: Search $0.007/request; markdown Fetch Extract $0.004/request. Included free calls are still counted at those estimates. These are internal budget estimates, not a claim about the Browserbase invoice. Successful calls settle at the reserved estimate; unknown/failed outcomes keep their reservation. The ledger preserves reservations even when authorization is later lost. Public per-second ceilings of two searches and five reads are checked under the shared budget lock. No automatic retries consume additional calls.

## Rollout checklist

1. Validate migrations with synthetic database fixtures; run Prisma validation/generation, typecheck, lint, tests and reviewed skeleton checks.
2. Test the compatible runtime, commit its source and package an immutable artifact with `webContract: "1"`.
3. Apply migration 31 to the explicitly configured nonproduction project, register the runtime with `scripts/setup-preview.mjs`, then provision protected Browserbase configuration and the bounded budget.
4. Restart the local preview worker while idle. Prepare a new web-enabled version; prior frozen versions are unchanged.
5. Verify a public search/read through the full broker/runtime path and review source links, permission denial and budget behavior. Use synthetic fixtures; do not use customer emails/documents as test input.
6. VM staging rollout is a separate explicit release: package/install the updated broker and runtime, propagate protected configuration and refresh host verification together. Merely pushing this source does not upgrade VM services.

## Sources checked

- [Browserbase Search](https://docs.browserbase.com/platform/search/overview)
- [Browserbase Fetch](https://docs.browserbase.com/platform/fetch/overview)
- [Browserbase plans and API rates](https://docs.browserbase.com/account/billing/plans)

The onboarding attachment is provider context, not a requirement to install global demo CLIs, run unrelated templates or enable paid browser features. This integration uses the project's package manager and the lightest supported APIs for the agreed scope.

## Verified local rollout — 18 September 2026

- Migration 31 applied to configured nonproduction project `jkgdxkacariasunhentd` through the dedicated migration role and verified TLS.
- Runtime commit `74d72b829a2d46088103eb419378f2b862245335`, registration `0.2.0-preview-74d72b82`, immutable manifest hash `6c6a8f8aebfd312242221a398e21205ea8fe45307af3b5999c154d12dba8ab54` installed locally. Its workspace grants preserve older releases and prepared versions.
- Owner-supplied Browserbase key stored only in ignored mode-0600 environments. Local Browserbase budget capped at $1 of conservative estimates; previous provider budgets and accumulated usage preserved. Local preview worker restarted while idle and verified running. No VM or Corby service changed.
- Direct provider smoke check succeeded for a public documentation search (five results) and Fetch (12,508 characters). These two setup diagnostics were separate from the agent ledger.
- Full restricted-customer → leased-worker → immutable-runtime → live-model → Browserbase test passed using a synthetic agent and public documentation. It searched, read the page and correctly answered the documented 25-result API maximum. Three metered model calls and two metered web calls completed, with broker-observed source links and no KB citations. Internal estimated usage was 13,635 micro-USD. The synthetic agent/preview/configuration records were removed; ledger usage was retained.
- An initial live run exposed OpenAI's rejection of JSON Schema `format: uri` for function arguments. The tool schema now uses bounded strings, with URL validation retained at the connector boundary. Failed diagnostics were not retried automatically; their reservations were preserved. The explicit evaluation configuration also keeps live tools disabled even with a web-capable frozen runtime.
- All 372 platform tests and 9 runtime tests passed. Prisma generation/validation, typecheck, lint, all 15 skeleton baselines, whitespace review and credential-leak scan passed. No production build was run.
- Browser review confirmed the existing shared card styling, independent web/Gmail selection, save-bar behavior, keyboard operation and the 390px layout without horizontal overflow. UI testing left the owner's draft unchanged.

Local use: enable Acceso web, save, prepare a **new version**, open Probar agente and enable that version's tools. Old frozen versions never acquire web access automatically. The VM needs the separately coordinated broker/runtime/evaluator rollout before activating a web-enabled version there; that deployment is not claimed complete here.

## Research quality and recovery — migration 32

The owner's Madrid rental test exposed answers that ignored mandatory constraints and a page-fetch failure that aborted the whole turn. The broker research policy now carries forward all criteria through follow-ups, requires page evidence for every mandatory field, treats unknowns as unverified and ranks only verified matches. With no verified match, it must say so rather than promote rejected listings. It cannot promise continued/background searching. These are model instructions tested by a behavioral benchmark, not a deterministic guarantee about all future answers or listing availability.

`web_tool_unavailable` events contain only job ID, operation, an allowlisted failure code and optional HTTP status. Categories distinguish blocked destinations, DNS failure, redirects, page HTTP errors, unsupported/empty content, malformed provider responses, rate limits, provider HTTP failures, timeouts and unavailable providers. They never include request URLs, queries, page/mailbox content, SDK messages or credentials. Failed/unknown operations keep their original reservation; a recoverable result is returned only after rechecking live authorization. If the remaining model budget cannot fund an answer, a local message explains the budget stop, with no further model request.

Since §74 a chat or preview turn's steps keep its search terms and the hosts of the pages it read, with the turn and scrubbed with it, so the person sees what the agent looked for. Logs still never contain them.

Run `pnpm web:benchmark` only against the configured nonproduction project while the ordinary preview worker is stopped and the queue is idle. This explicit live check uses the existing metered OpenAI model with synthetic, intercepted Browserbase responses, exercising the full restricted-customer → leased-worker → frozen-runtime path. It creates and removes a synthetic agent, preserves provider ledger entries and never reads a real mailbox or property listing. Browserbase fixture calls are conservatively recorded against the normal ledger even though the provider is not contacted. It neither resets nor raises budgets. Each of five cases is bounded by the normal session budget and research allowance. Results, including synthetic-only answers for manual review, are written to ignored `.local/web/research-benchmark.json`.

Cases cover rejected expensive listings, unknown parking, strict price boundaries, a matching listing after several rejections, an unreadable source, embedded hostile instructions and retention of criteria on a follow-up. The automated rubric checks the declared recommendation, whether its page was actually read, parking speculation and false background promises. Manual review checks factual justification. This small fixture suite isolates behavior and recovery; it does not measure real search ranking, listing freshness, market coverage or all possible phrasings.

Implementation follows the [OpenAI function-calling loop](https://developers.openai.com/api/docs/guides/function-calling): tool failures are returned as bounded outputs so the model can complete the answer. Authorization failures are never converted to ordinary page failures.

### Local research acceptance checkpoint

- Migration 32 applied to the configured nonproduction database. No applied migration was edited and no budget or accumulated reservation was reset.
- Runtime commit `7a470c3451c47f3539f685d73c1da24355187f8f`, registration `0.2.0-preview-7a470c34`, manifest hash `4217769d07c1684ffb0a1b6a8634cf146decf19d3831b856e23a564537c91938` installed locally. Earlier candidates retain their original three-call ceiling. When web is enabled, **Preparar versión** prefers the reviewed research-capable family; opening an existing preview never substitutes its engine.
- All five live-model synthetic cases passed the final rubric; manual review confirmed the correct price, bedroom/bathroom, parking and location explanations. The unreadable-source case actually encountered a 403 and then verified another source. The later-match case used five web calls, reading three rejected listings before the valid one. Earlier harness trials exposed a too-strict wording check and revealing fixture names; the final suite uses opaque URLs/titles and checks behavior rather than exact wording. No production policy was weakened to make those trials pass.
- The full platform suite passed 386 tests; the final preparation-selection change additionally passed all 31 workflow/preparation tests. Runtime tests (9), typecheck, lint, Prisma generation/validation and all 15 skeleton baselines passed. Deterministic tests additionally cover the eight-call ceiling, old three-call releases, budget stops, lost authorization, duplicate failures and the deadline's final-answer phase.
- Synthetic fixtures were removed and their usage/reservations preserved. The final five-case suite recorded 114,335 micro-USD of conservative combined model/tool estimates, including simulated Browserbase calls; this is not a Browserbase invoice. No VM or Corby rollout is included.
- A separate real-provider check then passed through the new frozen runtime: four model calls, three Browserbase calls, verified public documentation answer and source links (21,777 micro-USD internal estimate). Its synthetic agent was removed; usage was retained. The local preview worker was restarted with the new broker code.

## VM release checkpoint — 18 September 2026

Branches: `codex/public-web-research` (platform 0.11.0) and `codex/web-research-runtime` (runtime 0.3.0). Runtime source commit: `f272ddaac23612132bbe0bb0f03ba8e55183a4bc`; catalog registration: `0.3.0-preview-f272ddaa`.

| Installed artifact | SHA-256 |
| --- | --- |
| Runtime manifest | `5e776a45e4dd43d807f33fe6b05e058a373b21ecf6ad7b2ab8c68acdc2bb6129` |
| Staging broker/controller | `f00cf702e6e3be82f5d876ef8a2665515b462bc1e32996113bc4c39e72497fc2` |
| Evaluation worker | `774a4934d073575c926e7ab611becc8140e9b0b444bbd238a251b36f5461c049` |

The frozen runtime and fixed service releases are installed on `vm-agents-01`; their hashes match registration. `agentonic-evaluator-staging.service` and `agentonic-deployer-staging.service` are active. The broker has the protected Browserbase key; the evaluator does not. Both protected environment files are root-owned mode 0600. The matching local controller installation is also updated, preserving the local preview worker. Existing service configuration was backed up before replacement; no customer deployment was active during the update and Corby services were not modified.

VM host verification was refreshed at **2026-09-18 22:32:38 UTC** and evaluator verification at **2026-09-18 22:31:37 UTC**. Under the existing seven-day rule, reverify before **2026-09-25 22:31:37 UTC** to keep both usable. *(Historical: that deadline belonged to this 18 September installation. Renewal is now automatic; live expiry is shown in Admin **Vencimientos** and by `pnpm staging:reverify`, architecture §39.7.)* This is still private staging infrastructure; customer/admin web hosting and production activation are separate platform milestones.

The release pipeline now derives catalog versions from the runtime package version. Reusing identical content-addressed service bundles preserves their original build provenance even after documentation-only Git commits; source hashes still must match. Web-enabled agents' next explicit preparation uses the newest available research release, while opening an existing prepared version keeps its exact original runtime.

Acceptance: `check-review-flow-live.mjs --live --staging --web --rerank` completed six Azure evaluation checks, all passed, with six settled reranking operations. The existing policy correctly withheld automatic approval because the fixture requested tools. The harness was corrected to exercise the existing scoped staff approval gate for this synthetic workspace only; production approval policy was not changed. Staging checks resumed with `--resume-staging --staging --web --rerank`.

Both local and Azure staging deployments then passed activation, cited knowledge chat, real Browserbase search/read with source links and settled metering, stop/access denial and content cleanup. The VM additionally passed a systemd restart with conversation recovery. Internal estimated usage retained for the deployment tests: local 15,953 micro-USD; Azure staging 15,942 micro-USD. Synthetic deployments were stopped, the source document purged, the workspace retired and approval revoked; immutable review and usage history remain. No customer agent was automatically activated. The ignored `.local/staging/live-report.json` records the completed checks.

Release verification: 387 platform tests and 9 runtime tests passed, along with Prisma generation/validation, typecheck, lint, version consistency, 15 skeleton baselines and changed-file secret scans. Final preparation-selection checks passed all 31 workflow/preparation tests. The previously documented five-case live-model research benchmark remains the behavioral evidence; this deployment adds the real VM execution proof.
