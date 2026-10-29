# Agentonic: current state

**As of 29 October 2026 · platform v0.49.0 · nonproduction only.** A short summary of what runs where, what works and what doesn't exist yet. [The architecture record](agentonic-architecture.md) keeps the full, dated history. If the two disagree about the present, fix this page. Update it whenever a change alters what runs where.

## What runs where

| Where                                | What                                                                                                                                                                                                                                                                                                                                                                                                                 | Notes                                                                                                                                                                                                                                                 |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner's Mac                          | Development copies only: the apps under `pnpm dev`, and the twice-daily renewal job                                                                                                                                                                                                                                                                                                                                  | Nothing on the Mac serves the platform. Local development apps use the VM's knowledge worker, since they share the database; run `pnpm dev:worker` only while changing worker code. The renewal job still runs here (C19).                            |
| `vm-agents-01` (Azure, Ubuntu 24.04) | Customer app on `https://app.agentonic.avilabs.tech` and Admin on `https://admin.agentonic.avilabs.tech`, behind Caddy with Let's Encrypt; the knowledge and preview worker; evaluator service; staging deployment controller; one gateway holding the database connections and provider keys; one service per activated agent, resting while idle and without network or keys; runtimes 0.3.0 to 0.9.0 side by side | Platform release `platform-0.48.0-912f98fdbeae` installed with `pnpm platform:install` (architecture §53). Open to the internet on 80 and 443 only; SSH from the owner's address only. Live Corby runs on a separate VM and is not part of Agentonic. |
| Supabase (Frankfurt)                 | Postgres, Auth, Storage                                                                                                                                                                                                                                                                                                                                                                                              | One nonproduction project shared by the Mac, local staging and Azure staging. Free plan, Nano compute: no database backups, and inactive projects are paused.                                                                                         |
| External providers                   | OpenAI (answers, criteria, grading), Voyage (embeddings, reranking), Browserbase (web search and reading), Google (Gmail and Drive OAuth in Testing mode; Drive uses `drive.file` with the Picker)                                                                                                                                                                                                                   | Development caps: OpenAI US$100 (raised from US$25 on 14 October, §78), Voyage US$10, Browserbase US$1 in total. Accumulated use is never reset.                                                                                                      |

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
- Despliegues and Vencimientos showed servers as a grid. Since v0.41.0 (Despliegues) and v0.42.0 (Vencimientos), each shows only vm-agents-01, and Local (desarrollo) opens in a dialog from the page header. Since v0.49.0 they show two cards, Agentes and Evaluaciones, each with its icon and two metrics side by side.
- The agent page shows the latest version's tools as Gmail's, Drive's and a web mark.

**Agentonic's team (architecture §64), installed 9 October with platform v0.37.0 and migration 68.** Admin's **Equipo** page replaces the team card on Espacios de trabajo. Every staff member sees who is on the team. Administrators also see emails and invitations, and they can:

- invite people by email link as Administración, Operación or Soporte;
- change roles;
- deactivate or reactivate people, never themselves.

Staff accounts no longer need the Mac's bootstrap script. The invitation email now reads the same for both kinds of invitation, and the owner pastes it into Supabase again (outstanding C13).

**Volver atrás (architecture §65), installed 9 October with platform v0.37.1.** Volver atrás returns to the page you came from in the app, with its filters and tab; the breadcrumb still goes up. On the agent page, the number of an open review opens that review.

**Answers kept in Chats (architecture §66), installed 13 October with platform v0.38.0 and migration 69.** A turn in Chats or a scheduled run records its answer even when a failed web read or an interrupted model call left a reservation open, as previews already did. Before this, such a turn showed "No se pudo completar la respuesta." (NicolAI-Mail, 13 October). The open reservation stays charged and counts as unknown cost.

**Mailbox batch turns (architecture §67), installed 13 October with migration 70 and runtime 0.7.0.** On a runtime 0.7.0 version, one turn can work through a batch of emails. The [audit](mailbox-batch-audit.md) explains why, after NicolAI-Mail's request on 13 October.

- It makes 6 Gmail reads and proposes up to 10 drafts, each confirmed on its own card, as replies in their thread.
- It runs up to about 4 minutes and answers in up to 30,000 characters.
- The next turn sees what became of its Gmail actions.
- Mail agents on that runtime are evaluated with a 10-email case.

Failures name their cause in the job log. Earlier versions keep their limits until their agent moves to a new version.

**Mailbox follow-ups (architecture §68), installed 13 October with platform v0.40.0, migration 71 and runtime 0.7.0.**

- The agent reads whole threads.
- It proposes Gmail labels for a batch, confirmed on one card after the subjects are checked. This needs `gmail.modify`; older accounts show "Volver a conectar", which keeps their tools.
- Answers appear as they are written in Chats and Probar.
- An accepted Aprender mi estilo guide in the version's knowledge reaches every turn.

Both were installed together on 13 October:

- migrations 70 and 71;
- evaluator `0fe1ffe2`, with batch fixtures;
- staging broker `cc9e991d`, which both running deployments moved to;
- `platform-0.40.0-e08c79afab99`;
- runtime `0.7.0-preview-e08c79af`.

New versions use runtime 0.7.0. Google accepts `gmail.modify` for test users, and the requested scopes are declared in Google Cloud (N21, closed 13 October). An account connected before §68 reconnects once ("Volver a conectar") before it can label; Nico's already has.

**The batch case's mailbox reads Gmail search operators (architecture §69), installed 13 October with evaluator `7c84bad6` (platform v0.40.1).** The 10-email case's synthetic mailbox ignored operators, so `in:inbox` found nothing and NicolAI-Mail's first 0.7.0 version failed that case on both models. Only the evaluator changed; it serves runtimes 0.3.0–0.7.0, and the version is evaluated again.

**An evaluation's limit follows the selected models (architecture §70), installed 13 October with `platform-0.40.2-2277987ddbea`.** Runtime 0.7.0 reserves a call's full output ceiling, so GPT-5.4 and Astra no longer fit the old US$3.00 default together. "Evaluar modelos" suggests US$1 for GPT-5.4 mini, US$2 for GPT-5.4 and US$5 for Astra per configuration, and explains a run that stops on its limit.

**The grader sees that a write was only proposed (architecture §71), installed 13 October with evaluator `607e4a2d` (platform v0.40.3).** Fixture calls that were proposed for confirmation say so, so an answer that correctly says nothing was applied is not failed against them.

**A request may offer every granted tool (architecture §72), installed 13 October with staging broker `dc6c65b4`, evaluator `02f5920e` and `platform-0.42.1-63bd5949875b`.** A turn of an agent with all nine Gmail permissions and the web offers 12 tools on runtime 0.7.0, and the broker refused any request over 10, so NicolAI-Mail's first chat on its new version failed before answering. The protocol's limits now follow the tool catalogs (16 tools today), a test covers the largest possible grant, evaluation fixture cases offer every granted tool as a chat does, and a refused message names the field it broke. The broker, the evaluator and the preview worker are reinstalled with it.

**A turn survives what the model asks for (architecture §73), installed 13 October with staging broker `b5844821`, evaluator `6bea27a6` and `platform-0.42.2-babe3286d13f`.** NicolAI-Mail's turn 4 failed when Astra asked to read 10 messages in one response, past the 5 a batch turn takes. The broker now keeps the first calls and drops the rest, and gives refused arguments, failed reads and refused proposals back to the model; only a needed reconnect still ends the turn. A live harness on the real runtime 0.7.0 with Astra passed 10 of 10 turns of Nico's request; the previous broker failed the same case.

**A turn shows its steps (architecture §74), installed 13 October with migration 73, staging broker `9a036fa1` and `platform-0.43.0-5f9a0ac94eee`.** While a chat or Probar agente turn runs, it lists what the agent does, one line per tool call: "Buscó en Gmail «…» · 8 correos", "Leyó «…»", "Propuso el borrador «…»". Then the list folds into "Hizo N pasos" above the answer. The broker records the steps, with no runtime change. Migration 73 keeps them with the turn and clears them when the turn is scrubbed.

**A model's answer is read as it was meant (architecture §75), installed 13 October with staging broker `9dfa013a`, evaluator `ddbdd1cd` and `platform-0.43.1-9e55a9ba3796`.** GPT-5.4 writes progress notes as separate messages before its final answer, and GPT-5.4 mini sometimes marks an answer without citations as backed by the knowledge base. The frozen runtime refused both, so chats failed and evaluations stopped (the `leonardo@avilabs.tech` runs interrupted on 13 October). The broker now hands the runtime the final answer alone, with a consistent evidence flag. An evaluation fails only the case whose answer it can't read.

**Evidence by name, results by level (architecture §76), installed 14 October with migration 74 and `platform-0.45.0-ae4ac5b6da2d`.** Resultados and the criteria dialog list a situation's sources as document names, never their text. Resultados has one row per model and level and model chips, money shows at most two decimals in both apps, and versions read "v3". The draft's saves are "Edición N", so "Revisión" is only the review number.

**Agents use the Codex models (architecture §77), installed 14 October with migration 75, runtime 0.8.0, staging broker `26d06296`, evaluator `413426cc` and `platform-0.45.0-ae4ac5b6da2d`.** Evaluations and test chats offer GPT-6.1 Sol, GPT-6 Astra, GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, GPT-5.6 Terra and GPT-5.6 Luna, in the Codex app's order. GPT-5.4 and GPT-5.4 mini are retired for agents; GPT-5.4 mini still drafts criteria, grades and writes style guides. Only versions frozen on runtime 0.8.0 can use the new models. A version on an earlier runtime offers GPT-6 Astra alone, and says why.

**The OpenAI cap, refused calls and clearer stops (architecture §78), installed 14 October with staging broker `786dfcd8`, evaluator `02742183` and `platform-0.45.1-e0211aaef48b`.** The platform's total OpenAI cap is US$100. A call OpenAI refuses with a 4xx response (no credit, a rate limit) releases its reservation at zero. A turn stopped by a spending limit, or by the provider, now says so in plain words in Chats and Probar agente.

**Resultados by level, muted frame titles (v0.45.2), installed 14 October with `platform-0.45.2-2994e545effa`.** In Resultados each chip is one model and level and shows only that level's situations. The titles inside a situation's frames are muted text, so they stand apart from the text they introduce.

**Reservations hold counted input tokens (architecture §79), installed 14 October with staging broker `9ae92bdc`, evaluator `641cc5e3` and `platform-0.45.3-7d8c6b1e8680`.** Before a request longer than 16 KB, the host asks OpenAI to count its input tokens, which is free, and reserves those plus 5 % instead of one token per byte. A mail turn's last call reserved about four times its input's real cost, so NicolAI-Mail's summaries were refused for budget with money left.

**A raised period budget applies now (architecture §80), installed 14 October with migration 76 and `platform-0.46.0-2c807ddf8141`.** Raising a deployment's period budget in Ajustar renovación also raises the current period's limit; lowering it waits for the next renewal. Activación shows the limit actually in force this period. Before, the change only applied at the next renewal while Activación already showed the new amount.

**A draft's card shows its conversation (architecture §81), installed 14 October with runtime 0.9.0, staging broker `2c707578`, evaluator `8338d80e` and `platform-0.48.0-912f98fdbeae`.** Gmail action cards show Gmail's logo and the draft's subject. A reply's dialog has the tabs Conversación (the thread it answers, read from Gmail as the card opens and never stored), Borrador and Notas. Chat answers render Markdown. On runtime 0.9.0, the agent leaves a note on each draft and keeps its answer short instead of restating the drafts. Earlier runtimes keep their wording.

**Each turn shows what it cost (architecture §82), installed 14 October with migration 77 and `platform-0.48.0-912f98fdbeae`.** Under each answer in Chats and Probar agente, a muted line shows what the turn cost and, once earlier turns cost something, the conversation's total so far, as Corby does in Slack. A call that still holds a reservation is shown as "más hasta US$X sin confirmar". The figures come from the provider ledger.

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
| The batch case's mailbox reads Gmail search operators                  | §69                  |
| An evaluation's limit follows the selected models                      | §70                  |
| The grader sees that a write was only proposed                         | §71                  |
| A request may offer every granted tool                                 | §72                  |
| A turn survives what the model asks for                                | §73                  |
| A turn shows its steps                                                 | §74                  |
| A model's answer is read as it was meant                               | §75                  |
| Evidence by name, results by level, money to the cent                  | §76                  |
| Agents use the Codex models                                            | §77                  |
| The OpenAI cap, refused calls and clearer stops                        | §78                  |
| Reservations hold counted input tokens                                 | §79                  |
| A raised period budget applies now                                     | §80                  |
| A draft's card shows its conversation                                  | §81                  |
| Each turn shows what it cost                                           | §82                  |

Presentation rules are in the [UI contract](ui/ui-contract.md). The [target schema](schema.dbml) describes 90 tables; 73 exist in the 77 checked-in migrations.
