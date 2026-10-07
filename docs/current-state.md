# Agentonic: current state

**As of 7 October 2026 · platform v0.19.0 · nonproduction only.** A short summary of what runs where, what works and what doesn't exist yet. [The architecture record](agentonic-architecture.md) keeps the full, dated history. If the two disagree about the present, fix this page. Update it whenever a change alters what runs where.

## What runs where

| Where                                | What                                                                                                                                                                                                                                                                                                                                                                                                                  | Notes                                                                                                                                                                                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner's Mac                          | Development copies only: the apps under `pnpm dev`, and the twice-daily renewal job                                                                                                                                                                                                                                                                                                                                   | Nothing on the Mac serves the platform. Local development apps use the VM's knowledge worker, since they share the database; run `pnpm dev:worker` only while changing worker code. The renewal job still runs here (C19).               |
| `vm-agents-01` (Azure, Ubuntu 24.04) | Customer app on `https://app.agentonic.avilabs.tech` and Admin on `https://admin.agentonic.avilabs.tech`, behind Caddy with Let's Encrypt; the knowledge and preview worker; evaluator service; staging deployment controller; one gateway holding the database connections and provider keys; one service per activated agent, resting while idle and without network or keys; runtimes 0.3.0 and 0.4.0 side by side | Platform release `platform-0.19.0` installed with `pnpm platform:install` (architecture §53). Open to the internet on 80 and 443 only; SSH from the owner's address only. Live Corby runs on a separate VM and is not part of Agentonic. |
| Supabase (Frankfurt)                 | Postgres, Auth, Storage                                                                                                                                                                                                                                                                                                                                                                                               | One nonproduction project shared by the Mac, local staging and Azure staging. Free plan, Nano compute: no database backups, and inactive projects are paused.                                                                            |
| External providers                   | OpenAI (answers, criteria, grading), Voyage (embeddings, reranking), Browserbase (web search and reading), Google (Gmail OAuth in Testing mode)                                                                                                                                                                                                                                                                       | Development caps: OpenAI US$25, Voyage US$10, Browserbase US$1 in total. Accumulated use is never reset.                                                                                                                                 |

On 5 October the nonproduction data was reset: no agents, documents or deployments exist. User accounts, staff, workspaces, the audit log, the runtime catalog and the spend ledger were kept.

## What works end to end (nonproduction)

1. A customer creates an agent, writes instructions and skills, and uploads private documents (PDF, text, Markdown) that are indexed for retrieval.
2. They freeze a version and try it privately, including Gmail reading and web research.
3. They submit it. AI drafts evaluation criteria, which the customer confirms.
4. The version is evaluated on the VM, with several models if requested. Versions with Gmail or web tools also get platform tool cases run against synthetic fixtures (architecture §51). Routine versions are approved automatically; versions with tools need staff approval.
5. The customer authorizes private staging use (up to 7 days and US$1), and staff activate it.
6. The customer chats with the activated agent in **Chats**. Only that customer can read the conversation.

On 6 October the whole flow ran on the hosted names with no Agentonic process on the Mac: upload, processing, preview, criteria, evaluation, automatic approval, activation and chat, including an agent resting and waking for a second message on runtime 0.4.0 (architecture §53). Gmail reading was confirmed live on 18 September. Creating drafts and sending have not been tested live.

The Admin app has **Revisiones** (submissions, receipts, renewal and activation), **Vencimientos** (what expires, when and who must act), and the operations screens **Agentes**, **Despliegues**, **Actividad**, **Costos**, **Espacios de trabajo** and **Runtime** (architecture §52). Both agent lists show each agent's version in use and next version, Admin has a page per agent that every agent name opens, and Vencimientos groups servers by place (architecture §55). Installing servers, publishing runtimes and renewing verification are still done with scripts on the Mac; the screens show their state.

## Operations

- **Verification.** Hosts and evaluators stay trusted for 7 days. A launchd job on the Mac runs `pnpm staging:reverify --renew --publish` at 09:00 and 21:00. It checks the installed files and services over SSH, renews only what passes, and renews anything within 2 days of expiry. Run `pnpm staging:reverify` (read-only) for live expiry dates and what each environment runs: its worker release and each runtime's version and source commit. The local deployment host has been expired since 26 September on purpose; run `install-staging --local` before using local staging chats.
- **Alerts.** A GitHub workflow opens one issue assigned to the owner when:
  - a check fails;
  - a registration expires within 24 hours;
  - a VM service is waiting, stopped or failed, including the two apps, the knowledge worker and Caddy;
  - either hosted name stops answering over HTTPS, checked from GitHub every six hours, so this works while the Mac is off;
  - the VM can't be reached;
  - the Mac no longer holds what's needed to rebuild the VM;
  - the last VM backup failed or is stale, or the Mac's Azure sign-in has lapsed;
  - the Mac hasn't reported for 36 hours.
- **Services.** The controller, agent services and evaluator wait and report instead of exiting. The controller runs as its own user, without root, and polkit lets it start, stop and reset agent services only (architecture §47). Each change of state is one categorized JSON line in the journal. Restarts are capped.
- **Connections.** An agent with nothing to do rests: its service stops and uses no connection, and the controller wakes it when a message arrives. Awake agents reach the database through the host's single gateway, so with one instance of each app the platform needs 19 connections however many agents are activated (architecture §43).
- **Knowledge worker.** It runs on the VM under systemd, with restarts capped (architecture §53). Each kind of work has its own lane: cleanup, documents, searches and preview turns. Each lane is shared fairly between workspaces, so a slow document no longer holds up previews (architecture §45).
- **Upgrades.** The apps and the knowledge worker come from a platform release built in CI; `pnpm platform:install --azure --release=<tag>` checks every file on the VM, moves one service at a time through a health gate and restores the previous release if one fails, and `--rollback` goes back one release (architecture §53). New runtimes (`pnpm runtime:install`) and new agent worker releases (`install-staging`) install next to the running ones; running agents move over one at a time without stopping.
- **Restarts.** The VM restarts on Sundays at 04:00 Canary time, only when installed updates require it (`pnpm staging:restart-window`).
- **Secrets.** Each secret lives only in the processes that make the calls it is for (table in architecture §44).
  - Agent services hold no password or key and have no network: the host's gateway makes their provider and Gmail calls with their own credentials.
  - The knowledge worker reaches Storage with its own account, limited to documents whose ingestion or purge it is running. The Supabase secret key is bootstrap-only.
  - Stored Gmail secrets name the key that sealed them, and `pnpm connections:rotate-key` replaces that key in four steps without breaking any holder.
- **Backups.** Azure Backup takes a daily VM backup at 02:00 UTC and keeps it 14 days (vault `rsv-agents-spaincentral`). It doesn't cover the database. Rebuilding the VM from the Mac is documented in architecture §41.

## Not built yet

- Hosted beta: SMTP and invitations (C13), renewal and VM checks that don't depend on the Mac (C19), and a paid Supabase plan (and transaction pooling once apps run several instances).
- Production: a separate project and keys, ongoing operating authorization instead of the 7-day staging limit, budgets per period, backups with a restore drill.
- Product: external channels, automation, agent memory and Google verification. Chats, Gmail and costs now sit on the general model (architecture §§48–50).
- Scale: multiple hosts, the 250-agent synthetic load test, and a tested path to 500 agents.

The ordered plan is architecture §37; the owner's audit brief tracks progress. [Outstanding actions](outstanding-actions.md) lists every open item, who acts next and when it counts as done.

## Where to read more

| Topic                                                                  | Architecture section |
| ---------------------------------------------------------------------- | -------------------- |
| Approval, consent and staging activation                               | §36                  |
| Release plan (P0–P6)                                                   | §37                  |
| Re-verification, renewal and alerts                                    | §39.7                |
| Runtime engine and side-by-side runtimes                               | §40                  |
| Side-by-side workers, services that report, restarts, backups, rebuild | §41                  |
| Admin expiry view and customer availability wording                    | §42                  |
| Resting agents, the database gateway and the connection budget         | §43                  |
| Where secrets live; key rotation; agent services without secrets       | §44                  |
| Knowledge worker lanes and fairness between workspaces                 | §45                  |
| Release identity per environment; documentation drift test             | §46                  |
| The deployment controller without root                                 | §47                  |
| The general model: conversations, runs and messages                    | §48                  |
| The general model: connections and tool calls                          | §49                  |
| The general model: usage events and the daily cost summary             | §50                  |
| Evaluations that test Gmail and web tools against fixtures             | §51                  |
| Admin operations screens                                               | §52                  |
| Hosted beta: release, hosting, install and rollback                    | §53                  |
| Invitations, password reset and staff two-factor sign-in               | §54                  |
| What is in use and what comes next; the Admin agent page               | §55                  |

Presentation rules are in the [UI contract](ui/ui-contract.md). The [target schema](schema.dbml) describes 79 tables; 62 exist in the 51 checked-in migrations.
