# Agentonic: current state

**As of 13 October 2026 · platform v0.40.0 · nonproduction only.** A short summary of what runs where, what works and what doesn't exist yet. [The architecture record](agentonic-architecture.md) keeps the full, dated history. If the two disagree about the present, fix this page. Update it whenever a change alters what runs where.

## What runs where

| Where                                | What                                                                                                                                                                                                                                                                                                                                                                                                                                | Notes                                                                                                                                                                                                                                                 |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner's Mac                          | Development copies only: the apps under `pnpm dev`, and the twice-daily renewal job                                                                                                                                                                                                                                                                                                                                                 | Nothing on the Mac serves the platform. Local development apps use the VM's knowledge worker, since they share the database; run `pnpm dev:worker` only while changing worker code. The renewal job still runs here (C19).                            |
| `vm-agents-01` (Azure, Ubuntu 24.04) | Customer app on `https://app.agentonic.avilabs.tech` and Admin on `https://admin.agentonic.avilabs.tech`, behind Caddy with Let's Encrypt; the knowledge and preview worker; evaluator service; staging deployment controller; one gateway holding the database connections and provider keys; one service per activated agent, resting while idle and without network or keys; runtimes 0.3.0, 0.4.0, 0.5.0 and 0.6.0 side by side | Platform release `platform-0.38.0-cc3101be70d4` installed with `pnpm platform:install` (architecture §53). Open to the internet on 80 and 443 only; SSH from the owner's address only. Live Corby runs on a separate VM and is not part of Agentonic. |
| Supabase (Frankfurt)                 | Postgres, Auth, Storage                                                                                                                                                                                                                                                                                                                                                                                                             | One nonproduction project shared by the Mac, local staging and Azure staging. Free plan, Nano compute: no database backups, and inactive projects are paused.                                                                                         |
| External providers                   | OpenAI (answers, criteria, grading), Voyage (embeddings, reranking), Browserbase (web search and reading), Google (Gmail and Drive OAuth in Testing mode; Drive uses `drive.file` with the Picker)                                                                                                                                                                                                                                  | Development caps: OpenAI US$25, Voyage US$10, Browserbase US$1 in total. Accumulated use is never reset.                                                                                                                                              |

On 5 October the nonproduction data was reset: no agents, documents or deployments exist. User accounts, staff, workspaces, the audit log, the runtime catalog and the spend ledger were kept.

## What works end to end (nonproduction)

1. A customer creates an agent, writes instructions and skills, and uploads private documents (PDF, text, Markdown) that are indexed for retrieval.
2. They freeze a version and try it privately, including Gmail reading and web research.
3. They submit it. AI drafts evaluation criteria, which the customer confirms.
4. The version is evaluated on the VM, with several models if requested. Versions with Gmail or web tools also get platform tool cases run against synthetic fixtures (architecture §51). Routine versions are approved automatically; versions with tools need staff approval.
5. The customer authorizes private staging use for 30 days, renewing automatically while nothing changes, with a budget for each period (US$1–20), and staff activate it.
6. The customer chats with the activated agent in **Chats**, choosing among the models the approved version was evaluated with. Only that customer can read the conversation.

On 6 October the whole flow ran on the hosted names with no Agentonic process on the Mac: upload, processing, preview, criteria, evaluation, automatic approval, activation and chat, including an agent resting and waking for a second message on runtime 0.4.0 (architecture §53). Gmail was accepted live on 8 October on the hosted customer app: connecting, searching and reading, creating, editing and deleting a draft, and sending, each after one confirmation, plus cancellation, a refused second confirmation, an unconfirmed send that was never sent, and disconnecting ([gmail-connection.md](gmail-connection.md#live-acceptance-on-the-hosted-app--8-october-2026-b2)).

**Evaluation lessons (architecture §56), installed 8 October with platform v0.27.0, runtime 0.5.0 and evaluator `bf64e38d`:**

- the AI drafts criteria as requests a person would send the agent, and a version is approved with the models that passed every case;
- GPT-5.4 mini writes criteria and grades with rubric 5, which treats the agent's instructions as the authority for its own behavior;
- runtime 0.5.0 lets agents answer questions about themselves and work on pasted content, and new versions use it;
- GPT-4.1 mini is no longer offered.

Existing agents move to runtime 0.5.0 with their next version.

**Careful grading (architecture §61), installed 9 October with platform v0.33.0, migration 64 and evaluator `7dee5f53`.** New evaluations use rubric 6: GPT-5.4 mini grades at medium reasoning, accepts any of an expectation's alternatives, and fails an answer only by naming what is missing from it. The criteria writer expects a requested draft to be presented as a draft, without a notice that nothing was sent. Evaluations created earlier keep the rubric they were created with.

**Google Drive (architecture §62), installed 9 October with platform v0.34.0, migration 65, runtime 0.6.0, staging broker `ec30c590` and evaluator `7fb7104a`; not yet tested live.**

- **Tools:** an agent reads the Drive files its owner picks in Google's Picker, and proposes Google Docs it creates or updates, each confirmed once in chat or pre-authorized by a schedule.
- **Knowledge:** a curator imports picked files into a collection from Conocimiento, and they are synced hourly. A change cited by a running or approved version waits for "Aplicar cambios".

Only `drive.file` is requested, in the same Google project as Gmail. The live acceptance is in [drive-connection.md](drive-connection.md) (outstanding action N15).

**Names (architecture §54), installed 9 October with platform v0.35.3.** Anyone still on the "Miembro" placeholder chooses a name before using the customer app. Invitees already name themselves when accepting. The three ACME members who joined before that were named by a one-off backfill on 9 October.

**Aprender mi estilo (architecture §57), installed 8 October with platform v0.28.0.** In each Gmail account's frame in Configuración, the person who connected it can have the knowledge worker read the mail they sent in the last 90 days (at most 200 messages, never stored) and draft a writing-style guide. They review and edit it before it is added to a collection they curate. Since platform v0.33.1 (installed 9 October) a passing Gmail error is retried, and a message Gmail won't hand over is skipped instead of ending the run. Since platform v0.33.2 (installed 9 October) reads are paced and Gmail's rate limit is waited out; if Gmail still refuses, the guide is written from the mail already read. A 200-message run passed live on 9 October and its guide was accepted.

**Scheduled jobs (architecture §58), installed 8 October with platform v0.29.0 and staging broker `76c3155d`.** A Programaciones tab on the agent page lets a member schedule an instruction for an agent whose running version they authorized. Each run is an ordinary turn in the schedule's own conversation in Chats. By owner direction, a schedule may pre-authorize one Gmail write per run (to any recipient), which the platform executes without asking. The person can cancel it until it starts.

**Ongoing authorization (architecture §59, outstanding D5/D6), installed 9 October with platform v0.30.0 and migration 63.** Authorization lasts 30 days and renews automatically while nothing changed (opt-out), each period with its own budget (US$1–20, default US$5). Conversations follow the agent across versions and last 30 days from their last message; only closing, revocation, offboarding or that expiry erase them. Deployments authorized before the install keep their terms until their owner turns renewal on in Activación. No renewal has happened live yet.

The Admin app has **Revisiones** (submissions, receipts, renewal and activation), **Vencimientos** (what expires, when and who must act), and the operations screens **Agentes**, **Despliegues**, **Actividad**, **Costos**, **Espacios de trabajo** and **Runtime** (architecture §52), and **Equipo** (architecture §64). Both agent lists show each agent's Recursos (the saved draft's counts), version in use and next version, and Admin has a page per agent that every agent name opens (architecture §55). Installing servers, publishing runtimes and renewing verification are still done with scripts on the Mac; the screens show their state.

**Admin review polish (architecture §63), installed 9 October with platform v0.36.0 and migration 67.** The migration closed five older reviews of one agent left open behind its approved version.

- Approving a version closes the open reviews of older versions of the same agent as "Reemplazada", the way a withdrawal does. Reviews already left behind are closed by the migration.
- In Revisiones, **Ver usuario** shows who sent a review and where they belong. **Cambiar estado** offers only the changes the database allows, with a comment for the client.
- Despliegues and Vencimientos show servers as a grid: a row per kind, a column per place, one fact per line.
- The agent page shows the latest version's tools as Gmail's, Drive's and a web mark.

**Agentonic's team (architecture §64), installed 9 October with platform v0.37.0 and migration 68.** Admin's **Equipo** page replaces the team card on Espacios de trabajo. Every staff member sees who is on the team. Administrators also see emails and invitations, and they can:

- invite people by email link as Administración, Operación or Soporte;
- change roles;
- deactivate or reactivate people, never themselves.

Staff accounts no longer need the Mac's bootstrap script. The invitation email now reads the same for both kinds of invitation, and the owner pastes it into Supabase again (outstanding C13).

**Volver atrás (architecture §65), installed 9 October with platform v0.37.1.** Volver atrás returns to the page you came from in the app, with its filters and tab; the breadcrumb still goes up. On the agent page, the number of an open review opens that review.

**Answers kept in Chats (architecture §66), installed 13 October with platform v0.38.0 and migration 69.** A turn in Chats or a scheduled run records its answer even when a failed web read or an interrupted model call left a reservation open, as previews already did. Before this, such a turn showed "No se pudo completar la respuesta." (NicolAI-Mail, 13 October). The open reservation stays charged and counts as unknown cost.

**Mailbox batch turns (architecture §67), merged with migration 70 and runtime 0.7.0; not yet applied or installed.** On a runtime 0.7.0 version, one turn can work through a batch of emails. The [audit](mailbox-batch-audit.md) explains why, after NicolAI-Mail's request on 13 October.

- It makes 6 Gmail reads and proposes up to 10 drafts, each confirmed on its own card, as replies in their thread.
- It runs up to about 4 minutes and answers in up to 30,000 characters.
- The next turn sees what became of its Gmail actions.
- Mail agents on that runtime are evaluated with a 10-email case.

Failures name their cause in the job log. Earlier versions keep their limits until their agent moves to a new version.

**Mailbox follow-ups (architecture §68), in platform v0.40.0 with migration 71, for runtime 0.7.0; not yet applied or installed.**

- The agent reads whole threads.
- It proposes Gmail labels for a batch, confirmed on one card after the subjects are checked. This needs `gmail.modify`; older accounts show "Volver a conectar", which keeps their tools.
- Answers appear as they are written in Chats and Probar.
- An accepted Aprender mi estilo guide in the version's knowledge reaches every turn.

These ship with §67's rollout.

## Operations

- **Verification.** Hosts and evaluators stay trusted for 30 days (migration 52; it was 7 until 7 October). A launchd job on the Mac runs `pnpm staging:reverify --renew --publish` at 09:00 and 21:00. It checks the installed files and services over SSH, renews only what passes, and renews anything a week old or more, so the VM keeps working for 23 to 30 days with the Mac off. The GitHub alert for a silent Mac only fires once an expiry is within 5 days. Run `pnpm staging:reverify` (read-only) for live expiry dates and what each environment runs: its worker release and each runtime's version and source commit. The local deployment host has been expired since 26 September on purpose; run `install-staging --local` before using local staging chats.
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
- **Upgrades.** The apps and the knowledge worker come from a platform release that CI publishes by itself once a push to `main` passes its checks (architecture §60); `pnpm platform:install --azure --release=<tag>` checks every file on the VM, moves one service at a time through a health gate and restores the previous release if one fails, and `--rollback` goes back one release (architecture §53). New runtimes (`pnpm runtime:install`) and new agent worker releases (`install-staging`) install next to the running ones; running agents move over one at a time without stopping.
- **Restarts.** The VM restarts on Sundays at 04:00 Canary time, only when installed updates require it (`pnpm staging:restart-window`).
- **Secrets.** Each secret lives only in the processes that make the calls it is for (table in architecture §44).
  - Agent services hold no password or key and have no network: the host's gateway makes their provider and Gmail calls with their own credentials.
  - The knowledge worker reaches Storage with its own account, limited to documents whose ingestion or purge it is running. The Supabase secret key is bootstrap-only.
  - Stored Gmail secrets name the key that sealed them, and `pnpm connections:rotate-key` replaces that key in four steps without breaking any holder.
- **Backups.** Azure Backup takes a daily VM backup at 02:00 UTC and keeps it 14 days (vault `rsv-agents-spaincentral`). It doesn't cover the database. Rebuilding the VM from the Mac is documented in architecture §41.

## Not built yet

- Hosted beta: SMTP and invitations (C13), and transaction pooling once apps run several instances. Renewal without the Mac (C19) is deferred: registrations now last 30 days.
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
| Evaluation lessons: criteria as requests, rubric 5, per-model approval | §56                  |
| Aprender mi estilo: a style guide from the member's own sent mail      | §57                  |
| Scheduled jobs and pre-authorized writes                               | §58                  |
| Ongoing authorization, renewal and conversations across versions       | §59                  |
| CI timings, prepared test databases and automatic releases             | §60                  |
| Draft-only situations and a careful grader (rubric 6)                  | §61                  |
| Google Drive: live tools and knowledge sync                            | §62                  |
| Superseded reviews, Revisiones actions, server cards by kind           | §63                  |
| Agentonic's team in Admin: invitations, roles and deactivation         | §64                  |
| Volver atrás, breadcrumbs and opening reviews from the agent page      | §65                  |
| Answers kept when a reservation stays open; Gmail limits per turn      | §66                  |
| Mailbox batch turns: allowances, drafts as replies, longer turns       | §67                  |
| Threads, labels, answers as they are written, the style guide          | §68                  |

Presentation rules are in the [UI contract](ui/ui-contract.md). The [target schema](schema.dbml) describes 90 tables; 73 exist in the 71 checked-in migrations.
