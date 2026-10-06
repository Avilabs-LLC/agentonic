# Agentonic — architecture and implementation decisions

**Status:** accepted direction. Implemented in nonproduction: authoring, knowledge retrieval, automatic review, and private staging deployment and chat (§§30–36); Gmail and public-web tools (§§38–39); and, from §40 onward, the runtime engine, side-by-side upgrades and the operational hardening that followed. Since 6 October both apps and the knowledge worker are hosted on `vm-agents-01` for nonproduction (§53); production operation is pending. **What runs today:** [current-state.md](current-state.md). **Open work:** [outstanding-actions.md](outstanding-actions.md). · **Decision date:** 2026-09-13 · **Owner:** Agentonic founder

This is the authoritative architecture decision record for the initial Agentonic platform. It records the owner's accepted choices and the implementation judgment delegated to Codex for scope, operational details and corrections. Its authoritative schema companion is [schema.dbml](schema.dbml).

This record and its reconciled DBML supersede the earlier Claude and Codex proposals, which have been removed from this directory at the owner's request. Read the two files together: this record defines authorization, operational behavior and SQL-only requirements; the DBML defines the relational model. Accepted decisions are requirements for implementation, not a claim that every target capability is enabled.

**Reading this record.** Sections 1–21 are the accepted design. Sections 22 onward are dated checkpoints: each describes the platform on its date, and a later checkpoint supersedes an earlier one where they differ. Counts, installed hashes, verification dates and "not built yet" statements inside a checkpoint are history, not the present. [current-state.md](current-state.md) describes the present, and [outstanding-actions.md](outstanding-actions.md) lists every open item; it replaces §37's unchecked boxes as the list of open work. These earlier passages are the ones most often misread:

| Earlier text | Replaced by |
| --- | --- |
| §18: runtime source in the separate `agentonic-runtime` repository | §40: the runtime is `packages/runtime` in this repository; the old repository is the frozen record of releases up to 0.3.0 |
| §31.2: the planned VM layout, and preview runtimes packaged from a sibling runtime checkout | §§40–41: runtimes and worker releases install side by side in fixed directories; `pnpm setup:preview` and `pnpm runtime:install` package `packages/runtime` |
| §§36, 38–39 and [web-access.md](web-access.md): verification dates, deadlines and installed hashes | §39.7: renewal is automatic. Live expiry is in the database, shown in Admin **Vencimientos** (§42) and by `pnpm staging:reverify` |
| §§36–39: agent services holding the database password and provider keys | §43 (one gateway per host holds the database connections) and §44 (it also holds every provider key; agent services hold none) |
| §§30–36: one knowledge worker loop for every job | §45: one lane per kind of work, shared fairly between workspaces |
| §43: the connection budget of 18 | §45: 19, after the worker's pool grew to 4 |
| §§31, 37.1: the web apps and the knowledge worker run only on the owner's Mac | §53: both apps and the worker run on `vm-agents-01` behind TLS on their own names; the Mac runs nothing for the platform |

## 1. Product and launch boundary

Agentonic designs, configures, builds, deploys and maintains AI agents for individuals and organizations. Agents follow the Corby repository convention, adapted deliberately for centrally managed configuration. Customers use a dedicated customer web app to create agents, personalize instructions, upload knowledge, connect services, preview candidates and submit them for deployment. Agentonic staff use a separate admin web app to review submissions, evaluate, deploy and operate agents. Authorized customers can also use their agents through the customer app; people may interact through supported external channels without a panel login. Customer self-service setup is a launch feature, not a later addition.

The launch stack is **Next.js App Router and TypeScript, Supabase Postgres/Auth/Storage, Prisma, and separate Node.js workers and agent services on an Azure Linux VM**. A reverse proxy handles HTTPS. The platform repository holds two Next.js applications with shared server-side domain logic, authorization contracts, validation and UI components. Both apps follow the owner-approved UI contract in section 21, using shadcn preset `b1GfVg2Oe`. Workers and agent processes have independent lifecycles from both web apps. Customers never call staff-only operations simply because the two apps share code.

Launch uses managed Supabase alongside Azure-hosted application services. This is not a promise that all customer data resides inside Azure. Customers requiring a different hosting boundary need a deployment arrangement that meets it before onboarding.

The first release supports prompt, skill, tool and retrieval improvement with evaluations. **Provider model-weight training, automated invoicing and subscription management are deferred.** Accurate metering and operational spending limits are launch requirements.

## 2. Customer ownership and people

Use **workspace** as the canonical customer/tenant term, with personal and organization kinds. Every agent has exactly one owning workspace and an accountable owner who is an active member of it. An organizational agent remains owned by the organization when its accountable employee changes.

Use separate, linked concepts:

- **Users:** global identities for people who can sign into the panel through Supabase Auth.
- **Workspace members:** a user's role and active status in one customer workspace.
- **Contacts:** workspace-scoped people who interact with agents through channels. A contact may link to a verified user, but does not need a panel account.
- **External identities:** verified provider/account/user identifiers mapped to the appropriate contact.

Workspace membership, agent operation, agent configuration, transcript access and document access are distinct permissions. A member is not automatically an administrator. A contact is not automatically permitted to chat merely because its identity exists.

Provide explicit per-agent grants so an owner can share an agent with selected colleagues. Cross-workspace collaboration is outside the initial product; it must not be enabled by weakening tenant relationships.

## 3. Launch operating model

Run the admin/API, background worker and agent runtimes as separately supervised services. Agent tool code is reviewed and platform-managed at launch. Arbitrary customer-uploaded executable code is not a supported capability of the shared VM.

Use one migration authority for Agentonic's application schema: Prisma migrations with reviewed SQL for PostgreSQL-specific requirements. The application tables, types and relationships are explicitly qualified under the private `agentonic` schema. Supabase-owned Auth and Storage structures are not recreated by application migrations.

A separately owned agent-domain database may retain its own migration history. Agent runtimes never apply migrations to the shared Agentonic platform schema.

## 4. The five accepted decisions

### Wall 1 — Database-owned configuration; Git-owned code

**Accepted:** customers author prompts and non-executable skill instructions as database drafts. Freezing creates immutable configuration candidates for preview and review; freezing is not permission to deploy production. A customer submits an exact candidate and requested access for Agentonic staff approval. Code, tool implementations and template baselines remain in Git and have fixed reusable releases. Staff can assist within explicitly delegated customer scope. Customer instructions cannot edit platform security policy.

A configuration release identifies the complete behavior configuration: prompt composition and content hash, selected skill versions, model settings, tool enablement and policy, non-secret configuration and its compatibility with the code release. Published content is not edited in place. Changes create a new version.

Each deployment, run and evaluation records its exact code/configuration combination. Evaluation datasets and grading rules are versioned too. A turn resolves one coherent configuration at its start; it does not reread unrelated mutable “current” rows between tool calls.

The publisher materializes Corby-compatible `prompts/` and `skills/` files from the configuration release. These are generated runtime assets, not another editable source of truth. Prompt-only changes do not require rebuilding code, but still pass submission, staff approval and applicable evaluation gates before production activation.

The code registry remains authoritative for available handlers and minimum tool-security requirements. Database settings may restrict capabilities. Relaxing a permitted configurable policy requires an authorized, audited publication; it cannot override a hard code-level restriction.

**Live authorization remains live:** grants, membership, revoked credentials and standing permissions are checked when actions occur. Pinning a configuration version must never restore a revoked permission.

### Wall 2 — Application authorization and database enforcement from launch

**Accepted:** use application checks plus restricted database roles and RLS from the first real customer. Do not give every agent the platform's Supabase service-role credential or a broad database credential.

The initial runtime access pattern is a trusted internal API/service boundary. Each runtime authenticates with a credential bound to its agent and environment. The service verifies the runtime, the human/contact behind the request, and current grants. It derives workspace context rather than trusting model- or client-supplied identity fields.

Trusted application services use non-owner database roles without `BYPASSRLS`. A service operation sets verified context transaction-locally and executes its related queries on that same transaction/connection. Missing context denies access. Pool reuse, concurrent requests and worker execution must be tested for context isolation.

Migration credentials and secret-resolution privileges are separate from ordinary runtime data access. Model-generated SQL uses an appropriately restricted external-data connection; it cannot query the platform through its administration credentials.

Staff may inspect operational metadata needed to maintain the service. Private customer content requires an explicit authorized support scope and an audit record. Submission includes explicit consent for bounded staff review of the exact configuration and selected test evidence. Assigning a reviewer creates a scoped, expiring support grant; it does not expose unrelated conversations, documents or mailbox contents. A sophisticated support-approval UI may come later; the authorization rule exists at launch.

### Wall 3 — Bounded standing authorization for unattended tasks

**Accepted:** preserve useful autonomous schedules through explicit standing authorization. There is no global “auto-approve everything” rule.

An authorization records the responsible person, workspace, agent, environment, applicable schedule, permitted operation, relevant argument/resource limits, credential binding, validity or review deadline, and revocation state. For email, relevant limits include approved recipients and report/data scope. A tool-name list alone is insufficient.

On each execution, verify the authorization is current, the responsible person still has permission, and the actual action is within scope and budget. Record which authorization allowed the invocation. Human-only actions remain human-only; the registry/policy identifies which actions may use standing authorization.

One-off approvals bind to the exact invocation and arguments, expire and are atomically consumed once. Changing recipients or other approved arguments requires a new decision. Tasks without applicable standing authorization wait for an authorized person or fail explicitly; they do not silently bypass confirmation.

### Wall 4 — Contacts and panel users are separate

**Accepted:** keep the contact/user split described in section 2. Verify external identity through its actual provider connection, never through text inside a message or an unverified matching name/email.

Linking a contact to a panel user requires verified identity. Permission resolution uses the link consistently. Offboarding a linked person must also revoke their relevant chat access, API credentials, schedules and standing authorizations; leaving the panel must not leave a forgotten channel permission behind.

### Wall 5 — Systemd with fixed release directories

**Accepted constraint:** launch uses systemd and fixed release directories. Container images, Docker/Compose and an image registry are not required or budgeted for this phase.

Each installed release combines a fixed code artifact with a fixed published configuration. Prepare it in a new directory, verify hashes and assets, and activate it through a controlled service switch. Published directories are read-only to the runtime. Logs, checkpoints and mutable data live outside them.

Use separate runtime OS identities, restricted file ownership and service permissions, plus appropriate `MemoryMax`/`CPUQuota` limits. Limit restart loops. Agent processes must not administer systemd or gain unrestricted deployment privileges.

The worker uses a narrowly controlled deployment mechanism; queued payloads are validated commands, not arbitrary shell scripts. Keep credentials outside release artifacts and logs. Do not pull or build into a live release directory.

## 5. Adopted database and execution safeguards

The following nine safeguards are accepted with their implementation requirements:

| Item | Required result |
|---|---|
| Tenant-inclusive relationships | Composite keys bind customer-owned children to same-customer parents. Also bind agent, collection, conversation and release identity where consistency requires it. Tenant IDs cannot be reassigned through ordinary updates. |
| Tool exposure rules | Enforce Corby's read-only HTTP-surface restrictions against the actual versioned tool properties. Place checkable properties together or use an appropriate cross-row enforcement mechanism. Do not reference nonexistent columns in a copied check. |
| One-use approvals | Immutable approved arguments/hash, current approver authority, expiry, atomic consumption and a durable invocation state machine. |
| Request and trace IDs | Deduplicate inbound provider events and logical tasks with correctly scoped keys. Correlate logs with trace IDs. Retries retain the logical request identity. |
| Structural checks | Enforce message authorship, memory scope, valid status/value combinations and the required ownership relationships in database constraints where possible. |
| Schedule snapshots | Each uniquely identified occurrence records the schedule version/settings actually used. Claim the occurrence and enqueue work in the same transaction. |
| Neutral secret references | Ordinary records contain secret references only. The initial backend is Supabase Vault to keep the service count small; resolution is restricted to a trusted credential service/worker. A neutral reference leaves room for Azure Key Vault later. |
| Environments | Model development, staging and production explicitly. Bind credentials, destinations, deployments and runtime state to the intended environment. Staging must not accidentally send to production recipients. |
| Recoverable jobs | Expiring leases, renewal, stale-worker fencing, bounded backoff/retries and dead-letter handling. Serialize conflicting operations on one agent/environment while allowing unrelated work to proceed. |

The secret-manager selection is an implementation choice made under the owner's delegated judgment. Normal application/runtime roles cannot read Vault's decrypted view directly. If a runtime needs a credential, deliver only its permitted credential using restricted file ownership or a broker; do not expose a general secret-fetch capability to the model.

A unique job key or lease does not guarantee exactly-once external effects. Use provider idempotency support where available. When an external write's result is unknown, reconcile or request operator attention before resending.

## 6. Launch, later and conditional scope

These labels must appear beside the relevant entities in the reconciled schema and implementation plan. Do not infer scope from either proposal's table count.

| Capability | Scope | Boundary or trigger |
|---|---|---|
| Workspaces, contacts/users, grants, ownership and RLS | **Launch** | Required before customer data. |
| Customer creation, personalization, previews, submission and staff review | **Launch** | Separate customer/admin apps; frozen candidate, exact requested-access envelope, review history and staff-only production activation. |
| Shared code releases, configuration freezing and evaluations | **Launch** | Reusable Git artifacts, tenant-scoped availability, per-agent provenance and controlled activation. |
| Channels, conversations, SDK sessions, runs, tools and approvals | **Launch** | Authorized interaction, durable state and recovery. |
| Schedules, standing permissions, queue and platform jobs | **Launch** | Required for preserved Corby automation and maintenance behavior. |
| Common knowledge collections, sources, ingestion and structured summaries | **Launch** | Sources must be deliberately approved for their intended audience. |
| Private conversation ownership and participant authorization | **Launch** | Enabled group channels/conversations must have recipient checks. Unsupported or unknown audience cases stay disabled or use private delivery. |
| Same-workspace agent cooperation | **Launch foundation; enable per approved use case** | Explicit directional grants, original requester identity, bounded depth/fanout/cost and permitted output disclosure. |
| Original-source document ACL synchronization | **Conditional** | Implement and test before enabling any mixed-access source. Until then those sources are not connected. |
| Scoped staff-content access and audit | **Launch rule** | Explicit authorization even if approval is recorded operationally rather than through a polished UI. |
| Advanced support approval workflows | **Later** | Add when operational volume or a customer agreement requires them. |
| Provider usage ledger, daily summaries and spending caps | **Launch** | Accurate cost attribution and bounded unattended work. |
| Customer pricing engine, invoices, subscriptions and service-contract automation | **Later** | Add before offering the relevant automated billing feature. |
| Provider model-weight fine-tuning | **Later** | Add for a concrete approved training use case with dataset rights and evaluation. |
| Multiple embedding profiles active together | **Later** | Add when a real migration or retrieval requirement justifies it. |
| Container images, orchestration and multi-host routing | **Later** | Revisit with an explicit operational need and budget. |
| Cross-workspace federation or arbitrary customer executable tools | **Outside launch** | Requires a separately designed authorization/isolation model. |

The companion now names 72 tables: 71 launch entities and one conditional entity, `document_contact_access`. Deferred features are omitted. The conditional table has no incoming references from launch tables, so excluding it leaves a complete launch FK graph. A table is not a requirement for a separate CRUD screen. Deferred features must not require permissive placeholder policies.

## 7. Corby features and conventions to preserve

Preserve the stable entry points, single code tool registry, core runner, guardrails, surfaces/MCP boundaries, and the distinction between human-facing documentation and model instructions. `docs/` is not automatically inserted into prompts.

Keep `prompts/` and `skills/` as runtime asset homes. Adapt the prompt loader and skill-save workflow to database-owned drafts and fixed published bundles. Agent-generated skills are proposals; they do not immediately change all active agents. Any knowledge-base mirror remains a derived copy of a specific published version.

Retain these concrete capabilities:

- **Structured meeting summaries:** meeting date, participants, topics, decisions, action items and source provenance have an explicit model.
- **Kickoff and autonomous schedules:** explicit kickoff recipients/message, report destination and running memo, as well as the bounded authorization described above.
- **Platform jobs:** a separate platform-job queue/path for template sync and orchestration, alongside workspace-scoped tenant jobs. There is no fake customer workspace. Cross-customer maintenance dispatches authorized per-workspace work where applicable.
- **Timezones:** workspace settings contain an explicitly selected IANA timezone. Schedules inherit it visibly or select another; occurrences are stored as precise timestamps. Do not silently assume either UTC or mainland Spain time for every customer.
- **Agent-private durable state:** validated, workspace/agent/environment-scoped state for plans and similar features. Rebuildable caches may remain on disk; important state must be recoverable.
- **Embeddings:** one fixed-dimension retrieval profile initially, with model and parser/chunker provenance. Preserve Corby's 1024-dimensional shape initially, and verify the chosen model's configuration during integration. Model changes require an explicit reindex/migration; incompatible vectors are never silently mixed.

## 8. Resolved decision summary

| Decision | Accepted result |
|---|---|
| Wall 1 | Database-owned prompts/skills and complete immutable configuration bundles; Git-owned code/tool implementations. |
| Wall 2 | Restricted application/runtime authority, verified context and RLS from launch. |
| Wall 3 | Bounded standing authorization for approved unattended actions; exact one-use approval elsewhere. |
| Wall 4 | Separate contacts and panel users, linked through verified identity. |
| Wall 5 | Systemd, fixed release directories and controlled activation; no container-image requirement. |
| Database and execution safeguards | Adopt all nine safeguards with actual constraints and transactional enforcement. |
| Scope and Corby preservation | Use the scope and Corby-preservation decisions in sections 6–7 of this record. |
| Access, sharing, deployment and identity corrections | Adopt restrictive defaults, explicit sharing, deployment corrections and scoped identity/schema fixes. |
| Costs, recovery, acceptance and deletion | Adopt accurate costs/recovery/log protection, acceptance demonstrations, and selective deletion/scope labeling. |

## 9. Restrictive defaults

An empty allowlist grants no access. Public interaction requires an explicit access mode and its own permitted capabilities. An empty peer-tool list means no tools. Adding a new tool does not silently expand existing grants.

Before execution, verify tool enablement, release compatibility, registry restrictions, human/contact authority, agent grants, external-account scope and any required approval. Service status, identity existence or organization membership alone is not permission to perform an action.

## 10. Shared knowledge, private memory and agent cooperation

Check the agent, requesting person and actual output audience. An agent's right to read a collection does not authorize every caller or delivery destination to receive its contents.

Workspace common knowledge is deliberately published reference material. Personal memory, conversation state and private documents are not automatically promoted into it. Shared collection membership does not share credentials or SDK sessions.

Preserve original-source permissions before enabling mixed-access connectors. Retrieval filters apply before vector and full-text ranking. Deleted or revoked source material must stop being retrievable, including through old versions or caches. Establish a permission-freshness policy and fail closed when required authorization cannot be verified.

Delegation is directional and stays inside the same workspace initially. The child receives the original requester's identity and only the permitted task context, not the callee owner's authority. Check current link policy, caller/callee permissions, depth, fanout and aggregate cost. Verify child-output disclosure before returning or forwarding it. A loop between agents must not create unlimited tasks or charges.

## 11. Preparing, activating and replacing systemd deployments

A working deployment may coexist with a candidate being prepared. Do not impose a unique constraint that treats `building` and `running` as competing for the same slot. Historical rows do not permanently reserve live ports or service names.

The deployment record identifies the workspace, agent, environment, code release, configuration release, host, artifact hashes and lifecycle state. Use separate desired/observed activation state or equivalent explicit tracking. Filesystem changes, systemd restarts and database updates are not one atomic database transaction; interrupted activation must be detectable and reconcilable.

The initial activation procedure is:

1. Lock deployment operations for the agent/environment and prepare the candidate in a separate directory.
2. Verify assets, configuration compatibility and evaluation evidence. Candidate tests must not start duplicate production channel consumers or send real messages.
3. Drain or checkpoint current work as supported, switch the configured release target, and restart the service deliberately.
4. Verify the running process reports the intended code/configuration hashes and is healthy before recording activation success.
5. On failure, restore the previous combination only while its approval remains valid (or obtain explicit staff reapproval), restart and reconcile the recorded state. If neither combination is authorized, remain stopped and report the failure.

This can involve a short restart interruption; zero-downtime operation is not promised on the initial VM. Preparing the candidate does not require stopping the existing service. Rollback restores code/configuration; it cannot undo messages already sent or arbitrary database changes. Migrations must preserve the compatibility needed for the supported rollback window.

## 12. Required schema corrections

| Area | Decision |
|---|---|
| Namespace | Explicit `agentonic` qualification for application tables/types/references. Verify exported SQL targets it. |
| Customer relationships | Tenant-inclusive FKs and relevant agent/collection/conversation/release consistency constraints. Owner references must resolve to valid same-workspace membership. |
| Contact identity | Scope identity keys by workspace and verified provider/account namespace as appropriate; allow a person to be a contact in multiple customer workspaces. |
| Document identity | Use source identity plus stable external document identity. Two repositories containing `README.md` remain separate documents. |
| Tool catalog | Shared code release plus package/name identifies implementations; configuration selects tools per agent. Workspace availability and repository ownership govern visibility. Equal tool names do not imply identical implementations. |
| Customer submission | Immutable candidate and requested-access snapshot; append-only review history; actual staff approval and production initiation. |
| Previews | Frozen candidate on exact staging deployment, bounded expiry/budget, separate test connections and no production approval implied. |
| Current publication | Enforce at most one active selection where required and separately ensure an enabled resource has a valid published selection. Publication switches are transactional. |
| Invitations and offboarding | Record membership acceptance/revocation and preserve the last active owner. Auth-account invitation is not a substitute for workspace-role acceptance. |
| Memory | Enforce allowed combinations of person/conversation/agent scope and provenance. Apply expiry, correction and erasure policies. |
| Partial indexes and SQL | Review predicate semantics and nullable uniqueness. SQL-only rules belong in the migration history and tests, not only in prose. |

## 13. Costs, state recovery and log protection

**Provider costs are recorded once per attributable operation/meter.** Retain operation identity, workspace, applicable agent/run or ingestion job, model/provider, measurement time and available usage/pricing evidence. Unknown usage is distinct from zero. Keep provider-billed totals and estimated subtotals distinguishable so the same work is not charged twice in reporting.

Shared collection ingestion is initially attributed once to the workspace/source, not repeated in the actual cost of each agent with access. Per-agent reporting shows direct attributable cost. Any future allocation or customer markup is a separate calculation. Daily summaries are recomputed idempotently from the underlying facts using a defined reporting timezone.

Enforce workspace-level and applicable per-agent spending caps, plus per-run turn/tool/time limits. Reserve a conservative amount before provider work and settle actual cost afterward; concurrent jobs must not all spend the same available balance. Reconcile expired reservations against actual work before releasing them. Provider overruns remain visible rather than being hidden to make a cap appear perfect.

Persist actual SDK checkpoints or a verified supported reconstruction path. Storing an SDK session ID or a rendered transcript alone is not accepted as proof of recovery. Serialize turns that mutate the same session. Back up required state outside the VM and exercise replacement-host restoration.

Redact credentials and unnecessary sensitive payloads from logs, audit differences, exports and build output. A size cap is not redaction. Object access follows its authorized parent resource; ordinary workspace membership does not permit listing or downloading every stored file.

Before onboarding, configure finite retention for conversations, checkpoints, memory, source history, logs and backups. Purge derivatives and provider copies where the supported integration permits it, and document any remaining limits. Choose retention values during deployment/customer configuration rather than treating illustrative proposal defaults as universal requirements.

## 14. Acceptance requirements before real customer operation

The implementation must demonstrate the following with at least two test workspaces and several users/contacts:

1. Cross-workspace references fail, unauthorized reads/writes fail, and pooled connections do not retain another request's context.
2. Selected colleagues can share an agent or collection without exposing unrelated private transcripts, memory or restricted documents. Unknown audiences and stale required permissions deny disclosure.
3. Peer calls preserve the original actor's limits, enforce direction/depth/fanout/cost bounds and cannot recover revoked access through old configuration snapshots.
4. Every evaluated/deployed/run combination identifies its actual code, configuration and relevant dataset/grader versions. Published content cannot be silently rewritten.
5. Candidate preparation, failed activation, restart reconciliation and rollback work under the systemd directory model. Retired deployment history does not prevent legitimate port reuse.
6. Duplicate provider events, worker crashes, expired leases and conflicting deployment jobs recover correctly. Uncertain external effects are reconciled before blind retry.
7. One-off approvals cannot be consumed twice or reused with changed arguments. Standing authorizations reject out-of-scope, revoked, expired and offboarded-creator actions.
8. Scheduled occurrences are claimed/enqueued durably, kickoff flows work, and configured timezones/catch-up rules behave as intended.
9. Shared ingestion is counted once; cost reservations remain safe under concurrency; unknown usage is not displayed as measured zero.
10. A replacement host can restore the required runtime state. Authorized deletion/retention removes the intended data without deleting unrelated records, and secret values do not appear in ordinary logs or object responses.
11. A customer creates and personalizes an agent without a GitHub repository or VM slot, previews an exact frozen candidate, edits a newer draft without changing that preview/submission, submits, receives staff feedback and resubmits. Customer maintainer authority cannot approve or deploy production.
12. Staff review and production deployment record actual staff identities, validate scoped customer consent and match the exact approved submission. Rejection, withdrawal, superseding decisions, expiry, changed source scopes and revoked grants cannot be bypassed by queued jobs or rollback.
13. Two workspaces use the same sanitized code release with different configurations and isolated data. A workspace cannot use another customer’s custom code, enumerate its metadata or download its artifact. Retiring/deleting one agent does not delete another agent’s shared runtime.
14. Preview expiry, budgets, staging credentials and action limits hold even when customer inputs omit preview identifiers. Proposed source/tool expansion cannot affect a running production version; approved document refreshes work without redeployment. Prompt/knowledge text cannot grant additional tools or access.

Deterministic tests run without paid model calls. Behavioral evaluations use an explicit budget and safe targets. Type checking and linting use `pnpm typecheck`/`tsc --noEmit` and `pnpm lint`/ESLint. Do not run `pnpm build` or `next build` as a local verification shortcut; production artifacts are built through the deliberate isolated deployment process.

The revised DBML was parsed, exported to PostgreSQL and applied in a disposable PGlite database with pgvector. It contains 70 tables, 239 foreign keys and 194 check constraints. Structural validation passed 63 negative cases plus positive scenarios for shared code across two workspaces, customer-created agent drafts without repositories, member-frozen candidates, staff approvals without artificial workspace membership, staging previews without production approval, exact production approval tuples, existing runtime/knowledge/cost constraints and released-port reuse under separately installed proposed partial indexes. The conditional ACL entity was removed successfully without breaking launch references. All relationships between strictly tenant-owned tables include workspace_id; globally scoped code catalog references are deliberate and require the separate visibility/ownership rules described above.

These are disposable structural design checks, not implemented migrations or proof of RLS, immutable-history triggers, submission state transitions, JSON scope validation, custom-repository cross-row authorization, preview budget enforcement or systemd behavior. Those remain implementation acceptance requirements for the corresponding features. No customer database, VM or GitHub repository was changed during that design-validation exercise. Section 22 records subsequent foundation implementation and nonproduction database changes.

## 15. Deletion and scope discipline

Use restrictive deletion for customer roots, active resources and retained audit/cost history where appropriate. Use deliberate cascades for purely dependent disposable records when retention allows them. Do not apply either behavior universally. Document deletion order for version pointers and shared objects; one removed reference must not delete an artifact still in use elsewhere.

The reconciled schema must label each entity **launch**, **conditional** or **later**, with the enabling condition for conditional features. Keep core invariants explicit even when a UI is deferred. A feature cannot be enabled with placeholder authorization because its final controls are scheduled for a later phase.

## 16. Schema companion and implementation handoff

[schema.dbml](schema.dbml) is the reconciled model. It contains 72 explicitly scoped tables and 243 foreign keys under `agentonic`. PostgreSQL-specific controls below remain migration work; exporting the diagram alone does not produce a production-ready database.

The schema uses complete configuration documents rather than separate mutable “current prompt,” “current skill” and “current model” tables. `configuration_drafts.content` is a validated editable document. `configuration_releases.content` freezes all assets and settings, including each asset's path, revision and hash. `configuration_tools` is its normalized, immutable tool index. Freezing validates and writes both representations together, including a hashed requested-access snapshot. `code_releases` and `code_tools` are shared platform code records; `workspace_code_release_grants` authorizes availability without granting repository access. `agent_submissions` pins an exact candidate, and `submission_review_decisions` preserves append-only review history. `agent_previews` binds a bounded staging execution to that candidate. Production deployments reference an approved decision for the exact submitted code/configuration pair; freezing alone grants no production permission.

All interacting people resolve to workspace contacts. A panel user receives a contact linked through verified identity; this does not create membership for other contacts. Conversation ownership, participants and run actors reference contacts. Customer management grants and schedule responsibility reference members. Agent creation, freezing, submission, evaluation and deployment record the actual member or platform staff initiator; staff review decisions record staff directly. Staff need not become artificial workspace members to operate the platform. Authorization resolves the verified link and current membership consistently, including offboarding. Public channel mode may resolve an unlinked contact but still requires explicitly permitted capabilities; it grants no access to private data.

| Schema area | Main entities and purpose | Scope |
|---|---|---|
| Identity and authority | Users, members, invitations, contacts, external identities, agent grants and scoped support grants | Launch |
| Code and configuration | Code repositories, templates, shared code releases/tools, workspace release grants and per-agent drafts/frozen configurations | Launch |
| Self-service and review | Agent submissions, append-only staff review decisions, staging previews, actual member/staff initiators and scoped review consent | Launch |
| Integrations | Environment-bound connections, connection grants, endpoints, client API and runtime credentials | Launch |
| Operations | Host inventory, `agent_environments` service slots, deployment attempts, schedules/fires, standing authorizations, tenant and platform queues, audit and stored objects | Launch |
| Knowledge | Collections, explicit agent/member/contact readers, sources, ingestion, documents/versions/chunks, structured meeting summaries and singleton retrieval profile | Launch |
| Source ACLs | `document_contact_access`; freshness and effective upstream reader synchronization before mixed-access sources can be enabled | Conditional |
| Runtime and cooperation | Conversations, participants, real SDK checkpoints, runs, invocations/approvals, private memory/state, directional links and delegation lineage | Launch; enable cooperation per approved use case |
| Costs | Usage facts, append-only reconciliation evidence, daily summaries, budget periods and reservations | Launch |
| Quality | Immutable evaluation datasets, evaluation runs with frozen graders, per-case results tied to the exact code/configuration pair | Launch |
| Deferred features | Automated customer billing/contracts, model-weight training, simultaneous embedding profiles, advanced support UI, containers and multi-host routing | Later; omitted from DBML |

`cost_reconciliations` preserves late provider evidence without rewriting original facts. Reports select the latest accepted resolved amount **instead of** the original amount. They never add both. Provider operation totals and priced component meters must be reconciled into a disjoint set of costs. Workspace totals include shared ingestion once; per-agent summaries show direct spend. A null original measurement means unknown.

### Required SQL and transactional controls

These requirements belong in reviewed Prisma SQL migrations and service tests. DBML Notes describe them but do not enforce them:

1. **Private roles and RLS:** restrict schema/table/function grants; enable RLS on all customer tables, including their derived records and stored-object inventory. Use non-owner, non-`BYPASSRLS` service roles. Trusted services derive verified actor/workspace/agent/environment context, set it transaction-locally and issue related queries on that connection. Missing context denies. RLS must enforce resource/actor scope, not merely `workspace_id`. Restrict global host/template/profile/platform-job tables to appropriate platform roles. Global code repositories/releases/tools require visibility policies through approved workspace availability or staff role; workspace-custom code must not leak through catalog, artifact metadata or registry reads. A nullable owning workspace on code_repositories is an explicit global catalog boundary, not permission to bypass tenant restrictions. Migration and Vault access use separate authority. Policies and helper functions must avoid recursive authorization queries and unsafe `SECURITY DEFINER` search paths.
2. **Identities and owners:** add the external `users.auth_user_id → auth.users.id` relationship without recreating Supabase tables. Coordinate erasure with the active-user check. Lock workspace ownership changes so at least one active owner survives; agents must retain an active same-workspace accountable member. Verify contact/user links and cascade offboarding through permissions, keys, schedules and standing grants. Validate IANA timezones and finite retention schemas before activation.
3. **Immutable candidates and code:** prevent ordinary updates to fixed code artifacts, frozen configuration/requested-access payloads, asset/tool indexes, dataset content and grader snapshots. Allow modeled retirement/revocation metadata without changing content history. Draft edits increment one revision for both content and requested access. Freeze with optimistic revision validation and exact tool-index equality in one transaction. Verify code repository/template compatibility, current workspace code grant and custom repository ownership; a composite FK proves the grant record exists, not that it is currently valid. Shared artifacts contain no customer data and live in a platform-controlled private artifact store, separately authorized from tenant stored_objects. No automatic agent upgrade on release publication. Live authorization remains outside frozen snapshots.
4. **Service slots and activation:** add unique indexes on `(host_id, systemd_unit)` and `(host_id, os_user)` where `released_at IS NULL`; add uniqueness on `(host_id, service_port)` where `released_at IS NULL AND service_port IS NOT NULL`. Historical deployment rows do not reserve these resources. Do not combine candidate and healthy states into one uniqueness predicate. Serialize deploy/stop/restart through the same agent/environment lease with fencing. Verify stopped state before releasing a slot, and verify exact code/config hashes, host placement and applicable successful evaluation evidence before activation. A restored process must match observed state; filesystem, systemd and database are reconciled explicitly. Candidate evaluation may run before activation evidence exists, with safe staging targets and no live consumers.
5. **Exact approvals and standing permissions:** freeze canonical invocation arguments and restrict their full encrypted object to authorized execution. One-off consumption must lock the approval/invocation, verify current approver authority and expiry, record consumption once and transition execution atomically. Prevent resetting consumption or switching authorization modes to bypass it. For standing authorization, validate the invocation's actual tool, connection/reference, schedule occurrence, responsible member, resources, recipients, data limits and validity/review deadline. Check registry eligibility and live permissions on every call. Serialize occurrence counters/reservations so concurrent calls cannot exceed granted call/cost limits. Read-only tools still require resource authority.
6. **Recoverable work:** queue claims use leases, renewal, fencing and bounded retries; stale workers cannot commit completion. Server-derived conflict keys and service-slot locks serialize all conflicting operation kinds. Schedule edits increment revision; occurrence claims freeze effective settings/timezone and enqueue in one transaction. Bind scheduled runs back to the corresponding occurrence consistently. Derive inbound deduplication keys from verified provider/account/endpoint/event identity. Do not retry an unknown external write until reconciled. Platform jobs dispatch tenant work under separately derived customer context.
7. **Conversation and delegation rules:** add one-active-session-per-conversation uniqueness where session `status = 'active'`, plus turn leases and checkpoint compatibility checks. Validate membership in the actual delivery audience at send time. Check contact ownership/participation on messages and memory; same-tenant existence is insufficient. Delegated runs preserve original contact and environment, validate the directional link/tool allowlist, prevent cycles and enforce aggregate depth/fanout/cost limits. Evaluation result runs must use safe evaluation targets as well as their constrained code/configuration pair.
8. **Knowledge and retrieval:** validate source approval before enabling collection mode. Reject `source_acl` mode until the conditional feature is implemented and its freshness/revocation tests pass. Apply permission filters before ranking and check the eventual recipient audience. Maintain the full-text vector/GIN index and an appropriate fixed-dimension vector index. Publish a document's ready active version only after its intended chunks/embeddings are ready. Keep the singleton retrieval profile immutable while vectors exist; changing model space requires an explicit reindex. Source revocation immediately hides versions, structured summaries and caches.
9. **Cost and budget integrity:** enforce actual run/provider-connection and ingestion/source/connection consistency. Deduplicate provider operation/meter facts across retries, using stable provider account identity even if connection records are rotated or replaced. Count aggregate evidence only through disjoint resolved facts. Add null-aware uniqueness for daily summaries on `(workspace_id, agent_id, local_date, reporting_timezone)`. Exclude overlapping budget periods per workspace/optional agent scope, with correct null semantics. Lock workspace and agent caps in a consistent order; verify every reservation's subject fits its budget scope, reserve conservatively, settle once and reconcile expired holds against actual provider work. Unknown costs and overruns remain visible.
10. **Retention and remaining indexes:** add live invitation uniqueness on workspace/email with explicit acceptance/revocation state; expired invitations are revoked before reissue rather than using a time-varying index predicate. Add scope-specific live memory-key indexes for contact, conversation and agent scope where `deleted_at IS NULL`. Protect append-only audit/cost records and redact payloads. Purge in explicit order: clear active/version and deployment pointers when legitimately retiring their resources, remove retained referencing records only when policy permits, then delete dependent data and physically unreferenced objects. The diagram deliberately cascades only selected disposable children; those cascades do not authorize deletion of their parents. Shared artifacts survive while any authorized retained reference requires them.

11. **Submission and review state machine:** freeze submission identity, candidate, consent and customer note. Use append-only ordered decisions and update status in the same locked transaction. Allow submitted → in_review → approved/changes_requested/rejected, permitted customer withdrawal, and staff revocation; resubmission creates a new row, not a rewritten old decision. Reapproval after revocation requires an explicitly new submission/review of the same immutable candidate. Enforce one live submitted/in_review review per agent with a partial index. Only current active staff with the required role can approve; customer maintainer/owner can never do so. Validate reviewer support grant staff/workspace/resource scope and consent expiry at each private-content read. Approval must match the entire requested-access hash and reviewed resource revisions; a requested change produces a new candidate rather than silent reviewer edits. Deny activating an approval superseded by later decisions, withdrawn/revoked submission or expired activation approval. Approval expiry limits new activations; active runtime authority is separately governed by live grants and explicit revocation. Audit any effective grant changes and reconcile queued work on revocation.
12. **Requested versus effective access:** validate typed JSON schemas for source IDs, collection IDs, connection IDs/account identity, environment mapping, exact operations/resources/recipients, source-definition hashes, sharing/output ceilings and selected evidence. Every referenced tenant resource must belong to the submission workspace and be authorized to the submitter; JSON identifiers do not get FK protection automatically. Production grants require an actual approved decision and staff activation plus live customer consent. Compare effective grants with both that decision and the currently running configuration envelope; activating a broader grant for a future version must not expand the old version. Agent collection grants are environment-bound; filter sources/documents by that same environment. Stage additions and source-definition changes as proposals; do not edit live source scope before approval. Revocation/narrowing applies immediately. Source cursor/content refresh within unchanged approved scope creates document versions, not agent deployments. Credential rotation preserves identity/scope or needs renewed review. Enabled sources need curator authority and approved ingestion scope even if a customer OAuth connection is already active.
13. **Preview and actual actors:** freeze a candidate and provision a private staging deployment under server-controlled limits. Customers may request this without production rights. Execution references an unexpired agent_previews record, matching actual member/contact, exact deployment and code/configuration. Reject production credentials, consumers or recipients in preview. Apply preview/run/workspace budgets together; serialize stage-slot replacement and stop expired turns. Stage test connections require separate authorization; never copy production secrets. Staff creation/edit/freeze/submission/preview/evaluation requires a scoped grant; conditional checks require it for staff actors, and services additionally verify current scope, consent and expiry. Nullable grant columns accommodate customer actors, not unscoped staff access. Actor XOR constraints record member versus staff, and workers preserve the initiator without impersonation. Code artifact publication is staff-only. Production deployments require actual authorized staff and the approved submission/decision tuple, including rollback; semantic status/live-authorization checks remain SQL/service requirements.
14. **Shared code lifecycle:** publish code only from a verified ready repository and fixed commit; validate template runtime contract, artifact digest and safe registry. Availability grants for custom repositories can only target that repository’s owning workspace. Repository ownership/visibility and published artifact identity are immutable; a different sharing arrangement needs a new reviewed artifact/repository identity. Restrict global code and custom template metadata through RLS, and enforce artifact access separately. Add indexes supporting workspace availability lookups, pending submissions, ordered decisions and unexpired previews. Retire artifacts only after retained references permit it; security revocation blocks execution and schedules through live checks. The nullable workspace ownership of repository metadata is a deliberate cross-row rule to test, not a globally readable tenant table.

### Implementation sequence

The revised development order is in section 19. Build the shared foundation and identity/access services, then customer self-service authoring in step 3, its staff review/runtime counterparts in step 3.5, and complete the integrated preview-to-deployment journey in step 4. Extend both apps feature by feature. The first complete milestone includes real customer self-service, not chat alone. All enabled capabilities must pass their acceptance gates before real customer data is attached.

Preserve the live Corby repository during extraction: copy its conventions and reusable code, not company data or credentials. Framework versions, exact retention/cap values, host sizing and connector credentials remain settings to validate when implementation begins.

## 17. Customer self-service and staff deployment

The default launch journey is **create agent → personalize and educate → preview a frozen candidate → submit → staff review/evaluate → staff deployment → customer use and continued education**. Customers do not need GitHub or Azure accounts. Workspace owners/admins can create agents; agent owners/maintainers can edit, preview and submit within their resource permissions. Agentonic staff can prepare agents on behalf of a customer under explicit delegated scope, recorded as staff actions.

| Step | Customer app | Admin app / platform | Persisted result |
|---|---|---|---|
| Create | Choose approved template, name and accountable owner | Make templates/code versions available | agents; no GitHub repository or service slot required |
| Personalize | Write purpose/system instructions and skill instructions; choose allowed tools/model settings | Supply non-editable platform rules and validated registry constraints | configuration_drafts.content and revision |
| Educate | Upload selected documents, organize collections, connect accounts and propose sources/operations | Broker secrets, validate ownership/scopes and process authorized preview ingestion | connections, knowledge_sources, documents and requested_access proposal |
| Preview | Freeze current draft and run private budgeted test chat | Assemble exact staging candidate, use approved test connections/destinations and capture evidence | configuration_releases, configuration_tools, agent_previews, staging deployment/runs |
| Submit | Select exact candidate, note intent and consent to bounded staff review | Queue submission for review without changing active production agent | agent_submissions referencing immutable requested-access snapshot |
| Review | See progress, feedback and requests for changes | Check prompt/tool/access envelope, selected knowledge scope and matching evaluation evidence | ordered submission_review_decisions; edits require resubmission |
| Deploy | See approved/activating/live/failed state separately | Activate approved access and exact fixed code/configuration with staff authority | reviewed grants and production deployment referencing approved decision |
| Maintain | Chat, update documents, revoke access, edit a new draft and resubmit behavior changes | Monitor health/costs, maintain integrations and deploy or roll back approved versions | new document versions or new configuration/submission, depending on change |

`configuration_releases` means an immutable configuration version, including a candidate. It does not mean approved or live. Draft state, submission state and deployment health are independent. The UI can show “Live v3; changes awaiting review” rather than incorrectly marking the whole agent as pending. A code or configuration version is never silently replaced after approval. Approval certifies the configuration and resource-access envelope, not every future sentence in a continuously refreshed source; restricted uploads, ingestion validation and source authorization still apply.

The requested-access snapshot is a versioned typed manifest. It captures selected knowledge/source definitions, connection/account identities, desired tool operations/resources, environment-specific bindings, sharing/output ceilings and referenced scope revisions. It contains no secrets and does not confer authority. Approval is over its exact hash. Providers, user permissions and revocations always impose additional current restrictions. Changes to requested scopes require resubmission; approval is not a reusable wildcard for an entire provider account.

A connection, knowledge source and tool are different concepts:

| Integration | Knowledge source usage | Tool usage |
|---|---|---|
| Trello | Index selected boards/cards under an approved sync scope | Read current cards, create/move cards with explicit permissions |
| Google Drive | Index selected approved files/folders | Live search/read; separately permitted file creation/update |
| Gmail | Index explicitly selected authorized messages when supported | Live search/read, draft or send under distinct scopes and action approval |
| Database | Import selected records for retrieval | Execute bounded read queries; reviewed writes only through approved tools |

These are intended product capabilities, not claims that connectors already exist. One authorized connection can support ingestion and tools; enabling one does not enable the other. Start with uploads and one chosen connector. Mixed-access Drive/mail/database sources remain conditional on source ACL support or a deliberately selected uniformly shared scope. General mailbox ingestion is not the default.

Customers can refresh education without submitting every document edit. Authorized uploads and sync within an approved source scope produce new document versions. Adding a source, connecting a different account, expanding access, changing tools or changing behavioral instructions requires review before it expands production capability. Removing access must not wait for deployment. Knowledge is untrusted reference data and cannot override system policy. Preview can use customer-selected staging uploads before production approval; production data is not automatically copied into staging.

## 18. Repository and runtime ownership

The existing platform repository is [Avilabs-LLC/agentonic](https://github.com/Avilabs-LLC/agentonic). Its local origin was verified during this revision. It will contain the customer and admin Next.js apps, shared server/domain/UI packages, Prisma migrations and platform workers. Keep runtime/platform contracts versioned and compatible across repository boundaries.

The runtime repository is [Avilabs-LLC/agentonic-runtime](https://github.com/Avilabs-LLC/agentonic-runtime), with SSH remote `git@github.com:Avilabs-LLC/agentonic-runtime.git`. **Created by the owner; SSH read access verified on 2026-09-13.** The remote advertised no refs at verification, consistent with an empty repository. Private visibility is the required configuration and has not been independently checked. It will contain the sanitized Corby runtime structure, agent execution engine, reviewed tools/connectors and template baseline. Runtime extraction and release publication remain pending. No per-agent repository provisioning is part of customer onboarding.

**Update 2026-10-05:** the runtime source now lives in this repository as `packages/runtime`, and releases name it as their source; the runtime repository is frozen as the record of releases up to 0.3.0. See §40.

Optional workspace-restricted custom repositories are for independently maintained customer-specific code, ownership/access requirements or handover. They are not required merely because an agent has different prompts, skills, knowledge or enabled tools. Shared functionality belongs in the shared runtime when appropriate. Reviewed custom code may be supported under the same platform constraints; arbitrary customer executable uploads remain outside launch.

| Concern | Shared | Per agent / workspace |
|---|---|---|
| Runtime source and reviewed tool implementations | Git repository, code release and code_tools manifest | Explicit workspace availability; chosen version per configuration |
| Customer personality | Asset materialization format | Database prompt/skill/configuration drafts and frozen candidates |
| Knowledge, credentials and memory | Reusable connector implementation | Scoped connections, private objects/indexed records, permissions and state |
| Deployment | Reusable immutable code artifact | Fixed directory, configuration assets, environment credential binding and supervised service |

300 agents can use one shared code release while having 300 distinct configurations and deployment histories. They do not imply 300 Git repositories. Code publication makes a new version available; evaluation and explicit activation move each agent to it. Customer offboarding never removes a shared artifact still used by another workspace.

Each installed release materializes the Corby-compatible structure from approved code plus approved agent configuration. Keep runtime `data/`, logs and checkpoints outside fixed release directories. Sharing code does not mean sharing runtime processes, credentials, memory or customer storage. This does not establish that one VM has capacity for 300 active agents: benchmark CPU, memory, concurrency, provider quotas and recovery time, then expand host capacity when required.

Global `code_repositories`, `code_releases` and `code_tools` are platform catalog records with explicit access policies. A custom repository carries an owning workspace, and workspace_code_release_grants cannot grant its release to another workspace. This is a cross-row SQL/service invariant. Tenant stored_objects remains for customer artifacts; shared code uses a separate platform-controlled private artifact namespace. Agent templates reference repositories, while agent identities carry no required repository URL.

## 19. Revised development order

**Planning update, 2026-09-18:** retain this product roadmap and its acceptance requirements. Follow §37 for the next executable slices from the current implementation: essential operational fixes, one bounded connector and tool flow, complete hosted beta, production pilot, then measured scale. The recommended first connector is a planning proposal, not a recorded owner selection or authorization to connect external accounts.

Implement by useful end-to-end workflows. The 72 target tables are not 72 screens, and the entire schema does not need one initial migration. Each feature receives its required relationships and enforcement before it is enabled. If circular relationships cross migration stages, add those foreign keys in the later stage before enabling affected workflows; do not ship permissive temporary policies.

| Order | Deliverable | Completion evidence | External dependency |
|---|---|---|---|
| 1 | Shared platform foundation: two Next.js apps in one platform monorepo, shared UI/validation/domain services, section 21 UI contract and preset, server-only authorization boundary, worker shell, migration ownership, CI typecheck/lint/tests and skeleton audit, synthetic fixtures | Both shells run with the shared preset and matching loading states; authentication works against nonproduction Supabase; reproducible migration harness; no customer data | Development/staging Supabase and test identities for integration; no runtime repo or VM needed for initial scaffolding |
| 2 | Identity and access: workspaces, users/contacts, staff identities, agent creation authority, grants, audit, RLS and transaction context | Two-workspace tests prove tenant/resource isolation, actual staff identity and offboarding behavior | Bootstrap staff account, sample customer users, authentication email setup before external testers |
| 3 | Customer self-service artifacts: agent list/create/detail, system instructions and non-executable skills, revisioned drafts, requested capabilities, private document/collection management, candidate freezing and bounded submission consent/status | Authorized customers can persist and reopen their artifacts; concurrent edits cannot silently overwrite; uploads and reads enforce resource isolation; frozen submissions survive later draft edits; no fake preview or deployment state | Existing nonproduction Supabase and identity services; private storage configuration for uploads; real sanitized template/code catalog for agent creation and candidate freezing. Paid model calls are not needed for initial authoring |
| 3.5 | Admin counterparts and runtime: template/code management screens, submission queue, scoped artifact review, feedback/request changes, approval/rejection, evaluation, systemd staging deployment, health/costs and rollback | Staff sees only consented artifacts; decisions bind exact code/config/access; one sanitized agent runs on staging with metering/caps, lease recovery and deterministic evaluation; customer preview uses the same bounded runtime services | Runtime repository, model-provider key and explicit test budget, Azure staging access and private release artifacts; embedding credentials before retrieval-backed previews |
| 4 | Complete the customer/admin round trip: enable bounded live previews, ingestion/retrieval, review feedback/resubmission and controlled test production activation | Customer creates, educates, previews, submits, receives feedback and uses the approved deployed agent; draft edits do not mutate submissions; customers cannot deploy | Embedding provider/test credentials and authorized ingestion; domain/HTTPS for hosted testers; approved production setup before real activation |
| 5 | Customer daily use and education: chat/history, durable checkpoints/private memory, knowledge/source citations, one chosen connector, one-off approvals, member/collection sharing; admin diagnostics and costs | Customer can use and educate the agent; approved document refresh needs no deployment; private content and output audience remain protected | First connector sandbox/consent app and selected test data; custom SMTP for invitations |
| 6 | Automation and channels: schedules, standing authorization, deliveries, first external channel and complete cost/queue reconciliation; directional cooperation only for a chosen use case | Crash/retry/DST/approval/budget tests and safe delivery pass; disabled features have no permissive bypass | Relevant channel app, test recipients, approved unattended scopes; extra connectors separately provisioned |
| 7 | Operational acceptance and pilot onboarding: backup/restore on replacement host, offboarding/deletion/retention, concurrency/load tests, deployment failure drills and final onboarding/operational screens | All applicable section 14 gates pass before real customer operation; monitoring and recovery owner identified | Production Supabase, production provider credentials, SMTP, DNS/TLS, backup destination/retention, operating budgets and pilot scope |
| 8 | Expand by demonstrated need: more connectors, source ACL sync before mixed-access sources, approved cooperation, custom runtime repositories; refine onboarding/operations | Each enabled capability passes its own scope and recovery tests | Provider-specific approvals/accounts; more VM capacity only when measured demand requires it |

The first complete product milestone spans steps 1–5: an authorized customer creates and personalizes an agent, uploads knowledge, previews, submits, receives staff approval, uses the deployed agent and can submit a revision; staff can inspect health/cost and safely deploy or roll back. Customer authoring comes first in step 3; step 3.5 adds its staff and runtime counterparts. Neither step claims a working preview or live agent before the underlying execution, authorization and cost controls exist. External channels and advanced connectors can follow this milestone, but preserved launch automation and other accepted requirements must pass before the full launch offering enables them.

**Step 3 implementation slices, in order:**

1. Establish the minimal real template/code catalog through reviewed operator tooling, then build the customer agent list, creation and detail screens using existing creation authority. Catalog administration screens can wait until step 3.5. Do not relax the mandatory template/code references or seed fabricated runtime releases to make a screen work.
2. Add typed configuration drafts, system-instruction and non-executable skill editors, revision-conflict handling and requested-access controls. The system prompt is customer-owned behavioral content within immutable platform rules; selecting a tool proposes access and does not grant it.
3. Add private document uploads and collection management with size/type validation, authorized download, quarantine/processing states and removal. Uploaded is distinct from parsed/indexed/ready. Extraction, embeddings and agent retrieval remain unavailable until their workers and permission checks exist. Start with uploads; live Trello/Drive/Gmail/database connections retain their later connector milestone.
4. Freeze exact candidates and persist submissions with bounded review consent, customer notes and status/history. These require the real compatible code release, validated access snapshot and reviewed migrations. A candidate without evaluation evidence is visibly untested, never presented as having passed a preview. Live test-chat controls remain unavailable until step 3.5/4 supplies a budgeted runtime. Staff review actions arrive in step 3.5; customer edits create another draft/revision, not changes to a queued submission.

Shared service contracts, RLS, storage authorization, audit and offboarding must accompany each enabled customer feature; only the staff-facing screens and operational execution are deferred. The existing schema already represents these artifacts and does not need structural changes solely because the screen delivery order changes. The first customer slice still requires new migrations; the step 3 migration now adds configuration drafts, object/document storage and submission records, bringing the implemented slice to 28 tables. See section 24 for its limits.

Begin development with synthetic fixtures and deterministic tests. Integrate paid model/embedding calls only with explicit budgets. Keep admin and customer UX in step with shared service contracts. Do not run pnpm build or next build as local verification; use typecheck/lint and relevant tests. Production artifacts are built in the deliberate isolated release process. Local Supabase tooling may have its own Docker dependency; the Azure runtime remains systemd. A hosted nonproduction Supabase project avoids making local Docker a prerequisite.

## 20. External setup and owner actions

Both platform and runtime Git repositories are confirmed present; runtime SSH read access was verified. The owner's nonproduction Supabase project is `jkgdxkacariasunhentd`. Public Auth API access and strict-TLS session-pooler access are verified. The pooler endpoint is eu-central-1 (Frankfurt); exact project placement should still be checked in project settings if a residency requirement arises. The first five Prisma migrations are now applied: 28 identity/access/authoring tables, RLS, private Storage policies and audited permission commands; see sections 23–25. Dedicated migration/admin/customer/worker database roles are provisioned; the worker currently has no application-data grants. The owner created and confirmed the initial three Supabase Auth users. The explicit account-linking step has now created their three application identities, one administrator staff record and two separate customer test workspaces with active owner memberships. The supplied email addresses remain in ignored bootstrap configuration. The colleague identity remains pending and does not block the foundation.

SSH access through `vm-agents-01` was verified read-only: Ubuntu 24.04.4 LTS, approximately 32 GB RAM, 122 GB free root-disk space and no running application services or web listeners in the inventory. No VM changes were made. This is not a capacity benchmark or production-readiness claim. Domains, SMTP, model-provider accounts, connector registrations and production credentials remain external setup for their respective later stages.

The owner supplies account ownership, access, spending decisions and consent. Codex can prepare repository files, SQL/migrations, CI/deployment scripts, callback URLs, scopes and exact configuration steps as implementation makes them concrete. Provide secrets through local secret files or the designated secret manager/settings, never ordinary chat, Git or these docs. Account passwords and broad personal credentials are not required.

| Needed by | Owner action / information | What implementation will configure |
|---|---|---|
| Foundation integration | **Project URL/publishable key and verified-TLS database access passed.** Session pooler is configured; confirm organization/project placement when needed. Staff and two customer-owner emails supplied locally, colleague pending. Production remains a separate future project. | **Identity schema, restricted roles, first Prisma migration and identity RLS are implemented.** Auth URL configuration, private storage buckets and the Vault broker follow their feature stages. Keep separate production project before customers; development/staging can initially share one nonproduction project with coordinated resets and distinct workload environment scope. |
| Authentication / hosted testers | **Staff and both customer-owner accounts are confirmed and linked; colleague pending.** Their actual database access boundaries have been verified through both restricted app roles. Provide an SMTP service and approved sender/domain when invitations leave the project team. | Bootstrap one staff identity through an operator-only step, invitations, auth mail templates, sender/DNS configuration and callback allowlists. Customer sign-in never self-assigns staff status. |
| Runtime extraction | **Private repository, initial authoring contract and checksummed prerelease artifact published.** Runtime PR #1 is ready for review. | The first catalog release supports authoring only. Actual model execution, ingestion and deployment controls are next; no per-agent repositories are created. |
| CI and release storage | Confirm who can administer repo settings and the permitted CI/artifact storage budget. Identify a platform-controlled private artifact location with retention sufficient for rollback. | Environment-specific CI credentials and restricted release publication/deployment access; immutable code archives and checksums. No paid image registry required. Validate available GitHub protection features against the actual organization plan; application staff approval remains enforced independently. |
| Staging runtime | Identify Azure subscription/resource group, Linux VM distribution/version, region, size, disk capacity and existing workloads; make SSH access available via a named user/key. Identify whether the existing VM can host isolated staging safely. | Read-only inventory first, then narrowly privileged systemd deployment helper, runtime users, directories, reverse proxy and resource limits. Reuse existing VM when safe; no unplanned changes to live Corby services, ports or directories. |
| First paid preview/evaluation | **OpenAI selected; local API key configured; US$25 total development cap authorized.** The key is in ignored `.env.runtime.local`. Supply a compatible embedding provider/model for the selected 1024-dimensional profile before ingestion. | Provider connections, budget reservations, metering and environment-scoped secret resolution. Validate exact model availability/pricing during integration; no assumption that a personal chat subscription covers API usage. |
| Hosted apps | Confirm the owned domain and DNS access, and choose app/admin/staging subdomains. | Suggest concrete DNS records, reverse-proxy routes, TLS and exact Auth/OAuth callback URLs once hostnames are chosen. No domain name is assumed owned merely from the Agentonic brand. |
| First connector | Choose the first connector after uploads and supply a dedicated test account with deliberately selected data. For Google integrations, provide Google Cloud project/consent app ownership; for Trello or others, the relevant developer-app registration/access. | Minimal scopes, registered callback URLs, consent/account linking, token refresh/revocation, source selection and per-operation grants. Customers authorize their own accounts in the app; they do not send credentials to support. |
| Database connector, if selected | Supply an approved test database endpoint, database type, selected schemas/tables and restricted read-only credential via secret storage; arrange required network reachability. | Scoped connector and query limits, schema introspection permission, connection checks and safe retrieval. No broad platform database credential used for agent-generated SQL. |
| External channel / automation | Choose initial channel and provide app installation/admin consent plus safe test recipients. | Signature verification, endpoint routing, contact mapping, delivery audience checks and bounded standing permissions. Gmail access and email delivery are distinct integrations from authentication SMTP. |
| Production/pilot | Provide production project/provider access, budget ceilings, finite retention/recovery requirements, backup destination and operational alert recipients. Confirm approved pilot users/data and customer-facing privacy/support details. | Recovery drills, monitoring, spend alerts, onboarding policies, source approval and complete acceptance checks before real customer data. Production credentials remain separate from preview/test credentials. |

Supabase’s default email service is intended for testing and will not deliver to arbitrary customer addresses; configure custom SMTP before external invitations. See [Supabase SMTP documentation](https://supabase.com/docs/guides/auth/auth-smtp). Separate production/nonproduction data environments follow [Supabase environment guidance](https://supabase.com/docs/guides/deployment/managing-environments); Prisma remains this project’s migration authority rather than introducing a second migration system.

Google connector registration can be a lead-time dependency. Request the minimum actual scopes; sensitive/restricted scopes may require verification and restricted scopes may require a security assessment depending on use and applicable exceptions. Decide the first connector’s exact scope before committing to unrestricted Gmail ingestion or promising a release date. See [Google OAuth policies](https://developers.google.com/identity/protocols/oauth2/policies) and [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification). This is a connector-enablement dependency, not a reason to block uploads or the platform foundation.

**Foundation setup status:** both app shells, shared packages, identity migration, restricted roles and verification tooling are implemented; see section 22. The three confirmed Auth accounts are now linked, and their actual staff/customer database permissions have passed verification. Interactive password sign-in remains an owner acceptance check; passwords were not requested or changed. No additional secret key was required for activation. The colleague can follow later. Runtime repository and VM SSH access are confirmed. Domain, SMTP and provider setup can wait until their feature stages; connector registrations follow the selected connector.

Local database TLS verification uses Supabase’s published CA, downloaded from `https://supabase-downloads.s3-ap-southeast-1.amazonaws.com/prod/ssl/prod-ca-2021.crt`. The download location was verified against [Supabase’s dashboard source](https://github.com/supabase/supabase/blob/585477752aa35db85d41c0ef4ccd906e767ac503/apps/studio/components/interfaces/Settings/Database/SSLConfiguration.tsx); the certificate SHA-256 fingerprint is `807025ad50d4ed219d2c9c7d299c004f824eb00cf7f65afef607d07b72e6cafa`. It is configured only for this database client, not installed as a global system trust change. Deployment will supply the corresponding verified CA configuration through its own environment. See [Supabase SSL guidance](https://supabase.com/docs/guides/platform/ssl-enforcement).

## 21. Shared UI contract — admin and customer apps

The authoritative UI requirements now live in [docs/ui/ui-contract.md](ui/ui-contract.md), adapted from the Acachuchazo baseline and updated with the owner's 2026-09-15 badge rules. Read that contract before all UI work. It preserves Agentonic's preset, Base UI composition, navigation, forms, table/detail layouts and skeleton checks.

Primary record states may use a badge; nested outcomes use unboxed icons and text; metadata and counts use ordinary text. Current approval validity takes precedence over historical success in receipt headers. Domain descriptors centrally define status labels, tones and icons. These current rules supersede earlier badge-specific implementation notes below (including type, selection-count and prompt-readiness pills).

## 22. Shared foundation implementation — 2026-09-13

The repository now contains two Next.js 16.3.5 / React 19.2.4 apps (`apps/admin`, `apps/customer`), shared UI/contracts/server/database packages, and an idle platform-worker shell. pnpm 11.21.0 manages the workspace. Prisma 7.10.0 is pinned; the available Prisma 8 release candidate was deliberately not selected. The shared UI was generated using the approved preset with explicit Base UI. Its generated `components.json` base-color metadata was corrected to Mist to match the decoded preset and generated theme. Both apps use Figtree, the same tokens, Spanish copy, separate navigation registries and shared shell/table/form components.

### Implemented scope

- Password sign-in through Supabase Auth, server-verified identity, per-app host-only HTTP-only auth cookies, session refresh, sign-out, account pages and generic error states. An authenticated customer does not become staff; staff without customer membership receive no customer workspace access. No self-service signup, invitation delivery/acceptance screen, password-reset screen, MFA enrollment or production onboarding is implemented yet. Step 2 adds invitation services; see section 23.
- Shared inset sidebar, theme menu, breadcrumbs, page/record headers, loading primitives, table search/sort/pagination, form validation and notification helpers. Status palette, ID links, filters and confirmed row-action helpers are available for the next slices. Collection/detail links are only enabled when their pages exist. Agent/review/knowledge/connection navigation is visibly disabled. No fabricated runtime health or cost is displayed.
- The first migration implements **4 of the 70 design tables**: `users`, `platform_staff`, `workspaces`, `workspace_members`. It includes the external Auth FK, role/status checks, tenant RLS, current membership discovery, immutable identity constraints, timezone and finite-retention validation, workspace locking and deferred active-owner checks. Section 23 records the subsequent invitation, contact and resource-authority migration; execution lifecycle entities remain future work. The full 70-table DBML remains the target; no tables were removed from the design.
- Dedicated non-owner, non-BYPASSRLS `agentonic_admin` and `agentonic_customer` login roles have SELECT-only access to this slice. A separate `agentonic_migrator` owns migration objects. An `agentonic_worker` login exists but has no application-data privileges and is not supplied to the idle worker. No runtime receives bootstrap credentials. The only workspace discovery helper returns the verified caller's active memberships, while tenant reads additionally require the exact transaction-local workspace. Section 23 adds narrowly validated command functions while preserving the ban on direct DML.
- A narrowly scoped `agentonic_bootstrap.link_auth_users()` function, owned by the bootstrap authority and executable only by the migrator, adds the fixed external FK. Supabase's Auth-schema grant restrictions prevent directly delegating that DDL to the migration role. The helper accepts no arguments, returns no Auth data and grants no application access to Auth tables. Prisma remains the application migration authority.
- The first migration has been applied to the configured **nonproduction** Supabase project. A failed first attempt, which left no application tables, was marked rolled back through Prisma before the corrected migration succeeded. No existing customer data was reset or deleted.
- `setup:accounts` links only already-confirmed Auth identities named in private local configuration. Staff is created explicitly; two separate test organizations are created only after all three identities are confirmed. Re-running does not reactivate disabled staff, reassign existing workspace owners or change passwords. Test-workspace retention is explicit: seven days for conversations/checkpoints/memory/sources/logs/backups and thirty days for audit, with UTC display timezone. These are synthetic nonproduction values, not customer policy defaults. No real customer data or provider integrations are enabled.

### Foundation checkpoint verification and limits

At the original foundation checkpoint, **30 deterministic tests passed** across disposable database policies/constraints and server-auth boundaries. They cover missing context, cross-workspace reads, self-only identities, staff/customer separation, denied writes, current revocation, last-owner protection, invalid retention/timezone, stable tenant relationships, unconfirmed sessions and safe login feedback. Tests never use production content or paid model APIs.

Hosted read-only checks additionally verify each app's actual restricted role, RLS enablement, no owner/migration membership, denied DML/bootstrap-helper calls, concurrent identity isolation and clean pool reuse. The Prisma adapter passed a real strict-TLS query with transaction-local identity and an unknown-user denial. The worker's data access is denied. Typecheck, lint, Prisma schema validation and the six-route skeleton audit are included in repository verification and the checked-in GitHub Actions workflow. At that original checkpoint the workflow was prepared locally and had not yet run on GitHub; subsequent PR checks are reported by GitHub Actions.

Both dev servers were started on loopback: admin port **3100**, customer port **3101**, leaving port 3000 untouched. HTTP checks returned 200 for both login pages and health routes, and redirected unauthenticated protected requests to login. Health endpoints report web-process liveness only, not database/runtime health. No full production build was run. The owner subsequently created all three confirmed Auth users, and `pnpm setup:accounts` linked them successfully. Hosted read-only verification under both restricted app roles confirmed self-only identities, staff authority only for the designated staff account, one separate workspace per customer owner, no customer membership for staff, and denial of cross-workspace reads. Interactive password sign-in and authenticated UI acceptance remain to be checked by the owner with their private passwords; no visual-browser or production-deployment acceptance is claimed.

Prisma's macOS native TLS backend rejected the Supabase CA while node-pg verified the same endpoint successfully. The migration wrapper therefore creates a temporary `127.0.0.1` PostgreSQL bridge. It negotiates TLS with the real pooler and requires valid CA and hostname verification before forwarding anything from the child migration process. Only the local loopback leg is unencrypted; remote TLS is never disabled or downgraded. The bridge shuts down after Prisma exits. Runtime Prisma uses node-pg directly with verified TLS; no bridge or global trust-store changes are used by either app.

The idle worker starts and shuts down independently; it does not consume jobs, contact providers or claim deployment work. Durable queue leasing, runtime extraction, deployment helpers and actual agent execution remain later lifecycle work. Step 2 support grants are recorded below; their configuration/submission scopes come with those later features. The shared foundation is not a claim that steps 3–7 or the section 14 launch acceptance gates are complete.

### Owner setup needed next

1. **Completed:** all three Auth accounts were confirmed and linked through `pnpm setup:accounts`. Sign into the admin app with the staff account and the customer app with each customer-owner account to complete interactive acceptance. Use the passwords chosen in Supabase; keep them out of chat. No Supabase secret/service-role API key is needed for this approach.
2. Customer A's colleague can be added with the later invitation/membership flow. No need to invent an address now.
3. Before hosted testing, choose app/admin hostnames and provide DNS control; configure SMTP before invitations/password-reset emails to external users. Password sign-in to manually confirmed accounts does not require SMTP or an OAuth callback.
4. Before the small runtime lifecycle, provide the model-provider credential and development spend cap. The VM is accessible; operating users, release directories, firewall/reverse proxy and deployment services will be prepared in that stage, not assumed ready from SSH access alone.

Local setup commands and package locations are documented in the root README. `/docs` still contains only this authoritative record and its DBML companion.


## 23. Step 2 — identity and resource access implementation

**Step 2 checkpoint (extended by section 24):** server-side access services and the second Prisma migration, applied to the configured nonproduction Supabase project. There were **16 implemented tables out of the 70-table target** at this checkpoint. This milestone establishes authority for the upcoming workflows; it does not enable the agent editor, review screens, deployment, chat, ingestion or external channels.

The 12 added tables are `workspace_invitations`, `support_access_grants`, `contacts`, `agent_contact_grants`, `code_repositories`, `agent_templates`, `template_versions`, `agents`, `agent_member_grants`, `knowledge_collections`, `collection_member_grants` and `audit_events`. The catalog tables are included to enforce the required agent/template relationships. The shared runtime has not yet been extracted or published, and no fabricated template or agent was seeded into Supabase. Agent creation can succeed only after step 3 publishes a suitable template.

### Enforced permission rules

| Actor or grant | Implemented authority |
|---|---|
| Active workspace owner/admin | Create an agent draft and choose an active same-workspace accountable owner; manage permitted membership/invitation operations. Does not inherit access to another owner's private agents or collections. |
| Workspace owner | Assign owner/admin membership roles. An explicit offboarding/demotion command can transfer the departing member's resources to an active non-viewer successor, revoking earlier grants in the same transaction. The last active workspace owner cannot be removed. |
| Workspace admin | Manage member/viewer memberships and invitations. Cannot promote itself, change an owner/admin, or use ownership succession to take private resources. |
| Agent owner | Read/edit/invoke and share that agent. `maintainer` grants read/edit/invoke; `operator` grants read/invoke; `viewer` grants metadata read. None permits re-sharing, staff review approval, publication or deployment. |
| Collection owner | Curate and share that collection. Explicit `read` and `curate` grants are independent of agent grants. An active non-viewer member may create their own collection. |
| Platform staff | The admin application verifies active content-capable staff identity separately. Private resource reads require exact support authority; direct resource-table reads remain denied without an independent customer grant. Billing staff has no support-content authority. |
| External contact | Identity existence grants nothing. The future channel check requires an explicit, current `invoke` contact grant; an empty capability list denies. A linked panel user additionally requires their own current membership and agent invocation authority. The helper is not exposed to application or worker roles before a provider-verified channel boundary exists. |

Customer services use `requireVerifiedUser()` to verify Supabase identity and confirmed email. Submitted workspace/resource identifiers are requests, never proof of access. `withIdentity()` resets actor, workspace **and verified email** transaction-locally on every call. The email context is used only for invitation acceptance and is never taken from a submitted email field.

All 16 tables have RLS. Restricted app roles retain SELECT-only table privileges and receive EXECUTE only on approved helpers and `access_command()`. That fixed-operation function validates inputs, derives actors, locks the workspace, rechecks live authority, executes the operation and inserts its audit event atomically. There is no dynamic SQL or arbitrary mutation operation in this interface. Migration/bootstrap authority and the worker remain separate. Application services validate strict Zod contracts before calling the database and return generic failures without leaking database errors.

### Invitations, contacts and offboarding

Invitation services generate a random 256-bit token, persist only its SHA-256 hash and return the raw token once to the future delivery flow. Issuance expires within seven days. Acceptance locks the invitation, requires the server-verified intended email, current inviter authority and an active workspace, then creates or reactivates membership atomically. If a confirmed invited Auth user has no application identity yet, acceptance creates that identity through the existing external Auth FK. Deleted application identities cannot be silently resurrected. Duplicate live invitations are prevented; expired invitations are revoked before replacement. Ordinary SELECT does not expose invitation hashes, and the manager list omits them. No invitation email is sent by these services.

A panel contact can be linked only to the verified actor themselves. Unlinked external contacts remain separate from panel membership; provider identity mapping remains disabled until the channel feature. Blocking/offboarding cannot be undone by repeating the self-link operation.

Suspension/removal revokes the member's received and issued agent/collection grants, their support approvals and issued contact grants/invitations, and blocks linked contacts. Reactivation does not restore those grants. Removed membership requires a new valid invitation. Agent/collection ownership must be transferred before removal or demotion to viewer. These checks are backed by deferred database constraints as well as the atomic command. Future credential, schedule, standing-authorization and runtime tables must extend this offboarding path before being enabled; those capabilities do not exist yet.

### Support and audit scope

Support scope version 1 is a strict allowlist of 1–50 exact agent/collection IDs with the single operation `read`, an identified staff recipient, a reason and expiry within seven days. Every resource must belong to the workspace and be owned by the approving member. A workspace management role alone cannot authorize someone else's private resources. The grant's scope is immutable; expiry, revocation, approver offboarding, ownership transfer or staff disablement stops further access.

`support.read` returns the specified resource metadata/description and writes an audit event referencing the exact grant before the transaction commits. It does not grant direct SQL visibility or access to prompts, documents, transcripts, memory, credentials or other resources. Setup assistance, exact configuration review and selected evaluation evidence require new typed scopes and enforcement in steps 3.5–4; unknown scopes and operations currently fail closed.

Audit rows retain actor identity, resource reference, operation, outcome and request ID. Permission/member changes include an explicit allowlist of IDs, roles, statuses and succession fields. No arbitrary payload, invitation email/token, support reason, prompt or private content is copied to audit details. Audit actor/member and support-staff consistency is checked, updates are prohibited, and ordinary application deletion is unavailable. Failed authorization within an established workspace context produces a redacted denial event; requests without that authority and validation/constraint failures return generic errors without exposing tenant details.

### Verification and next milestone

**At this checkpoint, 82 deterministic tests passed** across actual migration replay in disposable PostgreSQL-compatible storage, resource/tenant isolation, grant capabilities, empty/wildcard scopes, contact/member separation, invitation expiry and replay, offboarding/succession, staff support boundaries, audit provenance, verified server identity and token handling. Prisma validation/generation, typecheck, lint and the six-route skeleton audit pass. No UI layout changed and no production build was run.

The new `pnpm db:check-access` command verifies the configured nonproduction accounts using the actual restricted app credentials. Its temporary resources, permissions, invitation acceptance and audit events run inside transactions that are always rolled back; it sends no emails and makes no Auth-user changes. `pnpm db:check` remains a read-only role/RLS/context check, now covering all 16 tables. Both restricted-role access checks passed against Supabase, with all temporary changes rolled back. The read-only checks also passed for all 16 tables, concurrent context isolation, clean pool reuse, denied worker access and the real Prisma adapter over verified TLS.

**Next at the step 2 checkpoint (now implemented in section 24): step 3, customer self-service artifacts; then step 3.5, the admin and runtime counterparts.** Follow the four authoring slices in section 19. Existing GitHub/runtime-repository and Supabase access support the initial catalog and draft work; private storage setup is required before uploads. A model-provider credential and explicit development spend cap become prerequisites when live preview/evaluation is enabled in step 3.5/4. The VM remains untouched until the runtime stage. SMTP and invitation screens remain prerequisites for inviting external testers.


## 24. Step 3 and initial step 3.5 — customer authoring and staff review

**Implemented in the development project:** customer agent creation/list/detail, revisioned instructions and non-executable skills, private knowledge collections and document uploads/download/removal, immutable candidate freezing, explicit seven-day review consent, submission history and withdrawal. Staff have a consented queue, exact configuration reads and feedback decisions (`in_review`, `changes_requested`, `rejected`). Approval, test chat, ingestion, deployment and operational monitoring remain unavailable. This is the authoring and review portion of step 3.5, not a completed runtime milestone.

The third Prisma migration adds 12 tables to the existing 16: `code_releases`, `workspace_code_release_grants`, `code_tools`, `configuration_drafts`, `configuration_releases`, `configuration_tools`, `agent_submissions`, `submission_review_decisions`, `stored_objects`, `knowledge_sources`, `documents` and `document_versions`. All 28 implemented tables have RLS; app roles have no direct table writes. A fourth migration fixes deferred ownership checks: their trigger functions use the migration owner’s authority with a fixed empty search path, so commit-time locks and complete workspace checks work without granting app roles UPDATE privileges. Tests flush deferred constraints before rolling back; rollback alone would miss commit-time failures. Future actor columns and operational states are closed by SQL checks. The DBML remains the 70-table target and is not a claim that all target capabilities are enabled.

### Real authoring catalog

The private `Avilabs-LLC/agentonic-runtime` repository now contains the first sanitized authoring contract, preserving the canonical Corby directory conventions without copying live credentials or business content. Its `v0.1.0-authoring` prerelease targets commit `c684d4740938714d4bbf5903c4d571425fa1e0df`. Runtime PR #1 contains that implementation; its typecheck and four runtime contract tests pass in CI. The archive checksum is `559ed56ed73e27187cbf4185d2923783cb643b5ad37c7261e292f126a2a52a87`. Its manifest explicitly declares `executionAvailable: false`; tools are empty and the runner refuses execution.

`pnpm setup:template` verifies the private remote, exact tag/commit, clean local source, embedded platform policy, archive bytes against `git archive` and checksums before registering the immutable template/code release. Availability is explicitly granted to the two configured nonproduction workspaces. No customer agent is seeded and no per-agent repository is created. This reviewed operator script is specific to this first authoring release; it is not a general runtime publication or deployment service.

### Drafts, candidates and review authority

Draft edits require a current agent owner/maintainer and an expected revision. Concurrent stale saves fail without replacing the saved draft. Selected collections require separate live read authority; agent sharing alone grants no collection access. The current content format accepts a system prompt and up to 20 named written skills. No shell, executable tools, model settings or connector grants can be smuggled through the authoring JSON.

Freezing pins the saved draft revision, compatible real code release, customer content, composed platform/customer prompt checksum, asset manifest checksum and collection/source definition snapshot. Subsequent saves cannot change a submission. Content/access/asset hashes use PostgreSQL canonical JSONB text; the composed-prompt hash uses actual UTF-8 bytes of platform policy, two newlines and customer instructions. Runtime integration must preserve these exact serialization contracts. Source snapshots describe requested scope; they do not imply indexed documents or production permission.

Submission requires explicit consent for staff to read this exact configuration and its requested knowledge metadata for seven days. The staff queue exposes only currently consented proposal metadata. The admin Revisiones page uses the shared searchable, sortable, paginated table with agent, proposal, status and an explicit audited opening action; its loading state mirrors that table. Opening a review is an explicit POST action that creates or reuses an exact submission-scoped support grant; subsequent reads are audited against that grant. Direct staff table reads cannot reveal customer drafts or document contents. Each read/decision rechecks consent, grant expiry, active submitter authority, workspace, code availability and collection rights. Withdrawal immediately blocks further review. Feedback decisions are append-only, tied to the frozen configuration/access hashes and explicitly marked unevaluated. Rejected or withdrawn candidates require another saved/frozen revision before resubmission.

### Private document boundary

The owner created the private `agentonic-documents` bucket with a 10 MB limit. The application accepts PDF, UTF-8 plain text and Markdown only, validates file names and bytes, and computes SHA-256 itself. PDF signature validation is not malware scanning; these files are quarantined from ingestion and model execution. The bucket's MIME allowlist is currently unset; the server enforces accepted types. Storage RLS permits only server-reserved object paths for the verified uploader and currently authorized collection readers. Inserts cannot overwrite existing objects; restrictive policies prevent direct client update/delete or anonymous access even if another permissive bucket policy exists.

`pnpm setup:storage` prepares a narrowly scoped migration-only bootstrap bridge because Supabase owns `storage`. Prisma invokes it to install policies. Blob writes occur only through the authenticated user's Storage API; application services use no service-role key. Upload completion checks actual Storage metadata against the reserved byte size. Document downloads recheck current authority and use private, no-store attachment responses. Offboarding permanently revokes upload source authority; reactivation cannot silently revive it.

The current workspace ceiling is 500 MB of reserved/retained inventory, including removed artifacts. Removal immediately hides and denies access to a document; physical blob deletion and failed-reservation cleanup await the retention worker and are not claimed complete. Uploaded documents remain `processing`, with no active document version, parser, embeddings or retrieval. Sources are disabled staging uploads; connectors and source ACL mode are closed.

### Verification and remaining setup

**109 deterministic tests pass.** They cover actual migration replay, revision conflicts, exact immutable submissions, tenant/resource isolation, expired grants, revocation/offboarding, denied approval/deployment, Storage JWT policies and upload service validation. Both app configs disable Next.js development server-function argument logging to avoid recording credentials or private form content. The shell verifies the session without duplicating each page’s database identity lookup.

Hosted `pnpm db:check-authoring` exercises creation, drafts, freezing, submissions, reservations and staff feedback through actual restricted app roles; all temporary records and audit events roll back after deferred constraints are forced. Both restricted roles passed the authoring and access checks against Supabase, including commit-time ownership validation. No paid model requests or Storage blobs are created by that hosted check. `db:check` passed for all 28 tables, role isolation and clean pooled context; the Prisma adapter passed verified-TLS and unknown-identity checks. Prisma validation/generation, typecheck, lint, version consistency and the 12-route skeleton audit passed. No production build was run. Browser testing used the authorized customer and staff accounts: agent/collection creation, prompts and skills, collection selection, private file upload/download, freezing and submission, exact staff review after a later draft edit, and staff feedback. A clearly labeled synthetic development agent, collection and document remain for inspection.

Next finish step 3.5/4: implement bounded runtime execution, ingestion and exact-candidate evaluations with metered cost reservations before enabling paid previews or approval. The owner selected OpenAI and authorized **US$25 total development spending**. The API key is configured in ignored mode-0600 `.env.runtime.local`, which holds `OPENAI_API_KEY` and `AGENTONIC_DEVELOPMENT_SPEND_CAP_USD=25`; this stored number alone does not enforce a budget. This milestone sends no paid calls. Verify model availability and pricing when that integration begins. Domain/DNS, SMTP for external invitations, production project/credentials and operational alert/retention choices remain the external setup listed in section 20. The VM and live Corby remain unchanged.


## 25. Page-load audit — 2026-09-13

Authenticated local development navigation was measured from browser navigation until the actual page heading became visible, using the existing synthetic customer workspace and staff account. These are individual observations with warm development servers, not production benchmarks, Web Vitals or statistical latency percentiles. Timing includes browser automation overhead and network access from this Mac to hosted Supabase. No production build was run.

| Page | Before | After |
| --- | ---: | ---: |
| Customer home | 1,459 ms | 1,129 ms |
| Customer agents | 1,198 ms | 767 ms |
| Customer knowledge | 1,163 ms | 819 ms |
| Customer account | 843 ms | 450 ms |
| Customer create agent | 1,654 ms | 825 ms |
| Customer agent editor | 1,694 ms | 1,119 ms |
| Admin home | 625 ms | 962 ms |
| Admin review queue | 856 ms | 702 ms |
| Admin account | 895 ms | 598 ms |

Most observed routes improved, especially customer authoring. Admin home did not improve in these observations; a further warm check took 1,148 ms. Development compilation, connection establishment, Auth and network variability remain relevant. An initial admin navigation also timed out before authentication, outside the comparable authenticated measurements above. Login and an active staff review detail were not included in the before/after table; the synthetic submission was already closed. These observations do not establish production performance or behavior under concurrent customer load.

### Implemented changes

- Server-side React `cache` deduplicates verified Supabase identity and identity discovery within each render. There is no cross-request session or authorization cache; commands retain live database permission checks.
- The fifth migration introduces an actor-scoped `identity_overview()` helper. One query returns the current user's identity, active staff role (only through the admin database role) and active workspace memberships. For one workspace, identity discovery drops from eleven database client round trips across two transactions to four within one transaction, including transaction/context overhead. It eliminates the additional transaction per workspace. The helper accepts no caller-supplied actor ID and is unavailable to public, anonymous, authenticated, service and worker roles.
- Authoring list/detail and staff queue/read commands take compatible shared workspace locks. They can run concurrently while permission changes and other workspace mutations still require an exclusive lock. Review reads no longer lock the submission exclusively; review mutations retain their locks. Consent checks and audit events remain in the transaction.

A hosted check measured identity query round trips at 62 ms for customer and 65 ms for admin, with database execution around 1.3–1.5 ms. This points to avoiding unnecessary network round trips as the immediate priority. Pool size, certificate verification and transaction timeouts were not relaxed.

### Verification and remaining performance work

All **112 deterministic tests**, typecheck, lint and the twelve-route skeleton audit pass. The migration is applied to the nonproduction project. The real Prisma adapter/context check passes. `pnpm db:check-page-reads` additionally verifies both restricted app roles: two readers can proceed concurrently, a conflicting writer must wait, and every test mutation/audit event is rolled back. Identity regression tests cover workspace isolation, staff separation, deleted identities and suspended workspaces.

Before production rollout, measure cold/warm navigation and concurrent workloads from the deployed VM using a separately prepared production build, and capture browser Web Vitals. Larger customer inventories will require pagination and narrower list responses; the current small synthetic dataset does not establish their scaling limits. This audit made no paid model calls or VM changes.


## 26. Authoring forms and creation dialog — 2026-09-14

Agent creation now opens a Base UI dialog over the agents list. The existing `/agents/new?workspace=…` URL redirects to that list with the dialog open. The dialog retains the approved shared tokens, focuses the name field, blocks closing during submission and opens the created agent's editor on success. The redirect route uses the agents-list loading skeleton.

Agent and collection creation use react-hook-form, Zod and inline Spanish validation. Invalid or pending forms cannot submit. Rejected submissions preserve values; successful collection creation clears its form. Interrupted requests offer an explicit reload after copying edits, without automatically resubmitting an operation whose outcome is uncertain.

Document upload validates collection selection, file presence, extension and size before submission. Controls are disabled during upload; successful uploads clear the file selection and retain the chosen collection. Server responses distinguish invalid files, excessive size, missing collection, expired session, origin mismatch, denied access, Storage failure and completion failure. Messages expose no provider errors or private content. Server-side byte validation, verified identity, current collection permissions and private Storage policies remain authoritative.

The reported plain-HTML appearance and collection/upload errors were not reproducible in a fresh authenticated browser against the running development server: styling, collection creation and a synthetic text upload worked before these changes. A stale browser tab after a development restart is a possible explanation, not a confirmed root cause. Reload existing tabs to receive the current scripts and styles; preserve unsaved changes first.

After the changes, browser verification confirmed agent creation through the dialog, legacy-URL redirection, invalid identifier rejection, retained values after a duplicate collection request, successful collection creation and a private synthetic upload. The upload button remains disabled until both file and collection are valid and becomes disabled again after successful file reset. All 115 deterministic tests, typecheck and lint pass. No schema migration, production build or paid model call was needed.


**PDF follow-up:** a synthetic 140,419-byte PDF uploaded successfully through the browser and is stored privately as pending processing. A binary PDF regression also verifies that PDF bytes are not decoded as UTF-8. This does not establish the cause of the owner's failing 138 KB PDF. Failed upload responses now carry a random reference and HTTP status; server diagnostics record only that reference, a fixed processing stage, status and error code. Document bytes/names, identities, request headers and raw exceptions are excluded. Responses that never reach the upload handler are identified as having no server reference. Generic failures no longer assert that a document service is offline.


**Confirmed header failure:** the owner subsequently reported HTTP 431 with no upload reference. A synthetic 20 KB Cookie header reproduced 431 before the upload handler on the running customer server; Node's default request-header limit was 16 KiB. This is independent of PDF size or backend deployment and can also prevent page assets and Server Actions from loading. Browser cookies are shared across ports on the same `localhost` host; the owner's exact cookie contents were not inspected. Both app development commands now set a bounded 64 KiB header limit while retaining loopback-only binding. Production startup and authorization are unchanged; no browser cookies were deleted. Use distinct app hostnames and narrowly scoped cookies in deployment.

Verification after restarting the customer server: synthetic 20 KB and 48 KB Cookie headers reached the upload handler, while 80 KB remained rejected with HTTP 431. The customer page loaded correctly after restart. All 119 tests, typecheck, lint and skeleton checks pass.


**Download follow-up:** the reported document URL returned HTTP 200, but the attachment response had a bare `Content-Security-Policy: sandbox`. The sandbox's download restriction is now lifted with `allow-downloads`, while scripts and same-origin privileges remain disallowed; `default-src 'none'`, attachment disposition, no-store and nosniff remain enforced. See the [CSP sandbox reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox). The list's download button fetches the authorized attachment, checks its response headers and initiates a named blob download, retaining the current page and displaying failures inline through a toast rather than navigating to an API error. Temporary blob URLs are revoked after the browser has time to acquire them.

The regression verifies exact returned bytes, encoded attachment filename, private cache policy and the restrictive policy with downloads enabled. All 120 tests, typecheck and lint pass. Browser verification observed the successful file response and download initiation with the knowledge page retained; the embedded browser did not deliver a download-completion event, so an actual saved file was not independently confirmed there.

## 27. Agent editor card layout — 2026-09-14

The owner confirmed that document uploads and downloads now work. The customer agent editor now follows the supplied Vercel-style reference: separate full-width cards for system instructions, skills, knowledge, tools and connections, followed by preparation, review and proposal history cards. Card headings use semantic level-two headings at 20px with semibold weight; descriptions use 14px text, and muted bordered footers explain each section. These treatments are scoped to the agent editor and preserve the approved preset and medium radius.

Skills use compact preview tables with instruction excerpts and an ellipsis menu. Details open a dialog for viewing/editing; removal requires an explicit confirmation. Add/edit validates required instructions, identifier syntax and unique skill names, with the existing twenty-skill limit. Applying or removing a skill updates the local form; the persistent save bar saves all draft fields together through the existing revision-checked server action. Failed saves retain entered data. Submitted versions remain unchanged. The editor uses react-hook-form and the shared Zod contracts; no authorization or schema change is involved.

The first five authoring cards use decorative leading title icons: ScrollText for system instructions, ListChecks for skills/procedures, LibraryBig for knowledge, Wrench for tools and Plug for connections. Tools and connections show only their capability description and an honest Próximamente state until their backends exist. The Trello/Google Drive example rows, mock detail dialogs, hide/restore state, example-removal branches and example notifications have been removed. The real skill list retains its draft-editing and removal behavior. Loading skeletons mirror the title icons and the smaller upcoming-capability cards.

The matching loading skeleton now contains the five configuration cards, save bar and two-column preparation/review section (stacked on mobile). Browser checks covered adding a synthetic local skill, viewing it, canceling with focus restoration, confirmed removal back to the unchanged draft, the tool detail dialog, and confirmed connection-example removal. The synthetic skill was never persisted. Desktop and 390px mobile layouts were visually reviewed. Typecheck, lint and all 120 existing tests passed; no production build or migration was run.

**Visual refinement, same day:** following the owner's second reference, skills, tools and connections now use borderless shadcn Item lists integrated into their cards. Remove the nested table frame, shaded column header and column labels; retain a subtle top divider and separators between entries. Names and type badges sit together, descriptions sit below, and ellipsis actions remain right-aligned. Dialogs, confirmations and persistence behavior are unchanged. The loading skeleton reflects these integrated rows.

**Content width refinement, same day:** the customer agent detail page and its loading skeleton now share a centered, fluid container capped at `max-w-4xl` (56rem / 896px). The header, configuration cards, save bar and review sections align within that column. Mobile retains the shell's responsive gutters; other pages keep their existing width.

**Collection picker refinement, same day:** replace the concatenated-value multi-select with a stacked, labeled Base UI checkbox list. Each collection keeps a visible name and selected state, with subtle row separators, keyboard focus indicators, the selected-count badge and a clear-selection action. The twenty-collection limit disables only unselected options so selections can always be removed. This remains local draft editing until Save; requested permissions and server checks are unchanged. The knowledge-card skeleton now reflects checkbox rows. Browser verification confirmed multiple selections and the corresponding unsaved state.

**Review sequence refinement, same day:** preparation and review submission now sit under a shared title and explanation with explicit “Paso 1 · Congelar” and “Paso 2 · Enviar” labels. Their grid uses equal fractional rows and stretched items, so both cards take the taller card's natural content height in any state, including stacked mobile layouts, without a hard-coded height or clipped content. The empty submission state directs the customer to complete step one. The loading skeleton mirrors the section and step labels. Browser measurements with the full submission form present confirmed equal heights on desktop (487.75px each) and mobile (530.5px each).

**Prompt validation and review actions, same day:** “Preparar versión” now uses the short description “Congela el borrador guardado.” Both review forms stretch through their card bodies and anchor their submit buttons at the bottom; browser measurements confirmed identical desktop button Y coordinates. The system prompt requires at least 50 characters excluding whitespace before saving or freezing. A shared input contract validates the draft-save command, both server actions return the prompt validation message, and the editor shows a live count plus an accessible inline error and disables invalid saves. Read schemas stay permissive so new/empty and older short drafts remain editable; existing frozen versions are not rewritten. Browser checks rejected 49 characters and enabled saving at 50, then restored the original field without saving. Contract tests cover whitespace padding, the 50-character boundary, legacy reads and rejection at the command boundary.

## 28. Agent listing configuration overview — 2026-09-14

**Current layout, 2026-09-15:** the customer listing combines saved-draft skill, collection, tool and connection counts in one Recursos column, using the same icons as the editor cards and accessible labeled tooltips. En revisión and Actual are separate columns; Actual reports the deployed version, with Sin desplegar when absent. Metadata-only viewers retain Sin acceso. The loading skeleton has seven columns. This supersedes the earlier combined Versiones layout below.

The customer agent list includes sortable columns for system-prompt readiness and character count, skills, requested knowledge collections, tools, connections, live version and active review versions, alongside ID, name, status and editing access. Counts describe the saved draft, never unsaved browser changes or the frozen submission. “Listas” means the prompt meets the 50-character minimum, not that its quality has been evaluated. Whitespace is excluded and Unicode code points are counted consistently by the editor and database. New agents without a stored draft show zero counts and incomplete instructions.

Migration `202609140006_agent_listing` adds the read-only `agentonic.agent_listing()` function, with customer-role-only execute privileges, verified transaction-local identity/workspace, active membership, compatible workspace read locks and per-agent authorization. One batch query returns metadata and counts without returning prompts, skill instructions or collection IDs. Configuration summaries are null for metadata-only collaborators; the UI shows “Sin acceso,” rather than misleading zero counts. The list page loads this overview alongside the existing workspace/template data without per-agent detail calls. No tables or DBML changes were needed; six migrations are now applied to nonproduction, retaining the 28 implemented tables.

Active review versions come from actual submissions in `submitted` or `in_review`, joined to their frozen release; all active entries are shown if more than one exists, and withdrawn/rejected/completed entries are excluded. Tools and connections currently have zero real assignments and are labeled “Próximamente.” Live version is explicitly absent (“Sin desplegar”) while deployment records remain unimplemented; no draft or code release is presented as deployed.

The shared shell now permits its content flex item to shrink, keeping the wide eleven-column table inside its own horizontal scroll area. The list skeleton includes the explanatory line and matching column count. Verification: 128 tests passed, including saved and empty counts, Unicode/whitespace handling, active/withdrawn submissions, workspace isolation and metadata-only access; Prisma generation/validation, typecheck and lint passed. The migration was applied using the dedicated migration role with verified remote TLS. Browser review confirmed the real nonproduction rows and contained horizontal overflow.

**Listing density refinement, same day:** prompt readiness now uses an accessible check/X icon badge beside the character count. Agent descriptions stay on one truncated line, with their full text in a Base UI tooltip on hover or keyboard focus. The two version columns are combined into “Versiones”: a deployment icon and version/empty state above review icons and actual submitted versions/statuses. The ten-column loading skeleton matches. Row actions now use an ellipsis menu with the working Edit link; costs/consumption, logs, stop and delete are visibly disabled under “Próximamente” because their backend workflows do not exist yet. No stop/delete request, fake success or live-runtime action is performed by these placeholders. Browser checks confirmed menu availability and the keyboard-accessible description tooltip.

## 29. Connected freeze/review prerequisites — 2026-09-14

The agent editor and its two workflow steps now share a single react-hook-form instance for the draft. Workflow buttons derive validity, dirty state and save-pending state directly from that form; opening a skill dialog also blocks the steps. The action handler checks the current form values again before making a request. Successful mutations keep controls disabled through the subsequent refresh. The customer can see a checklist of met/pending conditions in each card, while matching card heights and bottom-aligned buttons are preserved.

Step one requires a saved revision, valid system instructions and any supplied skills, no unsaved changes or open skill dialog, current access to every requested collection, and an available selected code release. It disables repeat freezing of the same draft revision/code pair. Step two additionally requires an eligible, unsent frozen candidate from the current saved revision, a valid optional note of at most 2000 characters, and explicit review consent. It no longer silently offers older candidates after a new draft revision is saved. Skills and knowledge collections remain optional; unimplemented preview/evaluation features are not invented as prerequisites.

**Engine and configuration clarity — 2026-09-15:** “Versión del motor” identifies reusable platform software (for example, `0.2.0-preview-…`); “Revisión N” identifies a saved agent draft. Freezing combines a saved draft with an exact engine and knowledge/access snapshot. “Versión congelada del agente” offers those immutable combinations and shows both the draft revision and engine version so two candidates from the same draft remain distinguishable. On entry or after saving a draft, the engine selector defaults to the newest frozen candidate's still-available engine, falling back through older candidates and then the available catalog. It must not reset an existing agent to the first catalog entry on every visit. The freeze button stays disabled when the selected revision/engine pair already exists, with an explicit explanation. Deliberately selecting a different available engine or saving a new draft revision permits a new combination once the other prerequisites are met. No existing candidate changes its engine.

The server enriches candidate detail with code-release identity and submission eligibility using the existing detail transaction's verified identity, RLS and workspace read lock. Retired candidates, unavailable code, revoked snapshot-collection access, already-submitted candidates and invalid frozen instructions cannot be offered as eligible. The customer receives eligibility metadata, not additional snapshot content. Freeze validates the full saved draft, while submission checks candidate ownership, current revision and eligibility before invoking the existing database command; database authorization, consent, uniqueness, code and collection checks remain the final authority. These checks use existing read grants and require no migration or broader privileges.

The specialized freeze/review forms use Zod and react-hook-form, including controlled consent and candidate selection. Missing candidates leave the review button and its dependent controls disabled. Failed requests retain form fields and show one error notification. The loading skeleton now mirrors the two requirement lists. Verification: 138 tests passed, including missing/invalid/unsaved drafts, open skill editing, consent, note limits, unavailable code/collections, duplicate freeze, stale/already-submitted candidates and pending operations. Browser checks confirmed live unsaved/invalid/open-dialog gating, restoration to the original saved values without persisting test changes, aligned action buttons and a clean console. No version was frozen or submitted during browser verification.


## 30. Upload RAG and document erasure — 2026-09-14

This section supersedes the earlier implementation checkpoint statements that ingestion, embeddings and physical deletion were absent. Prisma migration `202609140007_rag` adds six tables, bringing the implemented schema to **34 tables**. The companion target now contains **72 tables**; two are the narrow provider budget/operation ledger introduced here. Remaining runtime, production approval and connector capabilities are still closed. The earlier 70-table validation report remains a historical checkpoint, not validation of this revision.

### Pipeline and customer experience

1. The existing authenticated upload endpoint validates PDF/plain text/Markdown, maximum 10 MB, and file SHA-256. Files stay in the private `agentonic-documents` Supabase bucket. Completing the upload transaction enqueues ingestion under the actual uploader and collection.
2. The separate platform worker claims a renewable, fenced database lease. Every privileged step verifies current workspace, user, membership and collection curator permission. It reads only the exact database-reserved Storage path using a server-only Supabase secret key. That key bypasses Storage RLS and belongs exclusively in the worker environment; the web apps retain restricted keys/roles.
3. UTF-8 text is decoded strictly. PDFs use `pdf-parse` 2.4.5 in an isolated process with a 192 MB heap limit, 30-second deadline, no provider credentials and no output files. Limits are 200 pages and two million extracted characters. Scanned PDFs need OCR and fail with an explicit customer message; OCR and malware scanning are not implemented. Process isolation limits parser resources; it is not an operating-system security sandbox.
4. Deterministic `sections-v1` splitting preserves PDF pages, headings and character offsets, prefers paragraph/word boundaries, targets at most 2,400 characters with 240-character overlap, and permits at most 1,000 chunks. These are baseline parameters to tune against evaluation evidence.
5. The worker embeds batches of up to 16 chunks with **Voyage `voyage-4`, 1,024 dimensions, `input_type=document`, truncation disabled**. Questions use the identical model/dimensions and `input_type=query`. No Voyage-hosted document index is created. Supabase Postgres stores chunk text, hashes, citation locators and pgvector embeddings; the raw file remains in Storage. One immutable retrieval profile prevents mixed vector spaces.
6. Only a complete, authorized ingestion publishes a ready document version atomically. Partial vectors never enter retrieval. Existing uploads are not automatically sent to Voyage by the migration: authorized curators select **Procesar documento**. Subsequent completed uploads enqueue automatically. The Knowledge page shows queued, processing, ready/chunk count and actionable failure states.
7. The Knowledge preview selects an explicitly readable collection. A short-lived retrieval job rechecks access and materializes only currently authorized, active staging documents **before** ranking. Cosine similarity and Spanish/English/simple full-text results combine using reciprocal rank fusion, taking up to eight passages. Exact vector ranking is intentional at this scale: the provisioned HNSW index does not bypass authorization or solve filtered retrieval correctness. Measure and tune before scaling. No reranker is enabled yet.
8. The optional **Generar respuesta con fuentes** preview sends the question and selected passages to OpenAI `gpt-4.1-mini-2025-04-14`, with Responses `store:false`, no tools and a strict structured answer schema. It must cite actual retrieved chunk IDs or report insufficient evidence. Empty retrieval produces a deterministic insufficient-evidence response without an OpenAI call. Prompts treat source text as untrusted evidence. Valid citations establish provenance, not a guarantee that every claim is entailed; human evaluation remains necessary.
9. Results are reauthorized when polled and become unavailable if their evidence disappears. Query/answer records are accessible for at most ten minutes, with worker maintenance physically removing expired records. No browser local-storage cache or retained provider transcript is created. Customer document deletion also scrubs this workspace's outstanding/completed retrieval results immediately.

This is a **knowledge pipeline and grounded knowledge preview**, not an agent runtime preview. It does not apply an agent's frozen prompt, skills, effective agent grants or deployment envelope. Runtime integration must intersect caller, agent, source, environment and output audience permissions, and evaluate the exact frozen candidate before enabling production approval. Staff do not gain blanket access through this customer endpoint.

### Deleting a document means removing it from knowledge

The customer delete action immediately tombstones the object/document, clears its active version, deletes all chunks/embeddings, cancels ingestion and scrubs queued or completed retrieval/answer results in that workspace. Publication checks and lease fencing prevent an old worker from restoring content or publishing an answer after deletion. The file is immediately denied by the application's download and Storage authorization boundary. Already delivered downloads or text on another person's screen cannot be recalled.

A durable purge job then deletes the physical Storage object through the Storage API, followed by document versions, document row, upload-specific source, ingestion jobs, obsolete object jobs and stored-object inventory. Deletion does not remove the containing shared collection or other documents. Storage failure retains the tombstone and job, with retries rather than a false success. Purge authorization derives from the deletion record and survives uploader offboarding. The Knowledge footer reports pending physical deletions. A running, correctly configured worker is required to finish physical cleanup.

There are no separate local chunk files, external vector stores or runtime knowledge copies in this implementation. Content-free audit events and provider cost facts remain for accountability; immutable agent submissions retain requested resource identity but no copied document contents. Managed database/Storage backups, already delivered chat output and provider security logs are separate retention domains. This feature cannot promise immediate erasure of those. Before production, document the providers' retention settings and backup expiry, and ensure restores replay deletions before serving knowledge. Future connectors, summaries, memory and runtime caches must register their document provenance and join the deletion path before being enabled.

### Worker, cost controls and setup

- Local process: `pnpm dev:worker`. The worker loads ignored mode-0600 `apps/worker/.env.local`: restricted `DATABASE_URL` for `agentonic_worker`, `AGENTONIC_DATABASE_CA_FILE`, `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `VOYAGE_API_KEY` and optional `OPENAI_API_KEY`. `.env.example` contains names only. Restart the worker after changing keys. A separate supervised systemd service in fixed release directories is required on the Azure VM; this change does not alter live VM services.
- Bootstrap `pnpm setup:rag` installs pgvector if needed, with namespace verification. `pnpm db:migrate` applies reviewed Prisma migrations through the dedicated migration role and verified TLS. `pnpm setup:rag --budget` synchronizes the explicitly authorized total provider ceilings from the worker environment, preserving accumulated spend. The migration creates zero ceilings, so keys alone cannot spend.
- `AGENTONIC_VOYAGE_SPEND_CAP_USD` requires the owner's authorization. `AGENTONIC_OPENAI_RAG_SPEND_CAP_USD` draws from the previously authorized **US$25 total OpenAI development allowance**. No other OpenAI spender is currently implemented; future consumers must share or deduct from this same allowance, not receive another US$25.
- Both providers require an atomic reservation before every request. List-price baseline verified 2026-09-14: Voyage voyage-4 $0.06/million tokens; GPT-4.1-mini input $0.40/million, output $1.60/million. Conservative byte-based input ceilings plus overhead and maximum output reserve the expected upper bound. Unknown attempts retain the full reservation; retries reserve again, up to five job attempts. Known usage settles once, with overruns visible. These are conservative development controls and list-price estimates, not provider invoice reconciliation or full customer billing.
- The two provider ledger tables are an operational launch slice. Later `usage_events`/`budget_periods` integration must import each operation once by stable identity and add workspace/agent/run caps. No document body, title, question or secret is logged in the worker or ledger. A retained opaque job ID permits cost reconciliation after its content-bearing job is erased.
- Customer search is limited to ten queries/member/minute, one thousand question characters and twenty explicit collection IDs at the server boundary; the current UI selects one. Jobs use 90-second leases, heartbeats every 20 seconds, five processing attempts and indefinite purge retries. Unknown external model outcomes are never treated as zero cost.

### Verification and next development order

Deterministic tests cover real PDF extraction, chunk/page/overlap consistency, permission-filtered retrieval, citation validation, insufficient evidence, provider budgets, uncertain charges, expired leases, immediate deletion, stale publication rejection and Storage cleanup ordering. Mock provider tests do **not** establish live Voyage availability or answer quality. Never use real customer documents as automated fixtures.

Before claiming retrieval accuracy, run a representative, explicitly authorized evaluation set: expected source IDs/passages for answerable questions, paraphrases in the actual customer languages, no-evidence questions, conflicting versions and access-denied cases. Measure retrieval hit rate at eight, relevant ranking, citation correctness, unsupported claims and explicit abstention; preserve only synthetic fixture results in Git. Add reranking or change chunking only against this baseline. Exact-candidate agent evaluation follows, using the same retrieval implementation and live grant checks.

Historical order before the owner-approved preview-first revision in §31: **(1)** configure worker keys/caps and verify ingestion/retrieval/purge end to end; **(2)** evaluate RAG quality on approved documents; **(3)** connect the runtime repository and exact-candidate staging preview with agent/caller access intersections; **(4)** finish staff evaluation/approval; **(5)** implement controlled systemd deployment, health checks and rollback; **(6)** customer chat plus operational costs/logs. A knowledge preview alone must not unlock approval or production deployment.

Provider references: [Voyage embeddings](https://docs.voyageai.com/docs/embeddings), [Voyage pricing](https://docs.voyageai.com/docs/pricing), [Supabase hybrid search](https://supabase.com/docs/guides/ai/hybrid-search), [Supabase secret keys](https://supabase.com/docs/guides/api/api-keys), [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [GPT-4.1-mini](https://developers.openai.com/api/docs/models/gpt-4.1-mini).


**Implementation verification:** migration 7 is applied to the configured nonproduction Supabase project (34 application tables, seven Prisma migrations). `pnpm db:generate`, `pnpm db:validate`, `pnpm typecheck`, `pnpm lint` and 165 tests passed; the 12-route skeleton baseline was reviewed and updated. Hosted role/RLS checks and existing authoring/review regression checks passed with test changes rolled back. The revised 72-table/243-FK DBML parsed, exported and applied in disposable PostgreSQL-compatible PGlite with pgvector. Browser checks verified the Knowledge controls, answer toggle and required-question validation. No production build was run.

**Live activation — 2026-09-14:** the owner configured Voyage and Supabase Storage worker keys and a US$10 Voyage cap. That cap is synchronized to the database; OpenAI retains the prior US$25 total allowance. The local worker is running against nonproduction Supabase, and `pnpm dev` now starts it alongside both web apps. `pnpm dev:worker` starts only the worker. It is not yet installed on the Azure VM; local processing pauses when the Mac or worker stops.

`pnpm rag:check-live` is an explicitly paid nonproduction smoke test, not part of CI. It creates a temporary synthetic collection/document, verifies real Storage upload, Voyage embedding, hybrid retrieval, an OpenAI answer with valid source citations, abstention on an unsupported question and denial for another workspace. It then removes the document and verifies immediate chunk removal, cached-answer invalidation, physical Storage disappearance and related-record cleanup. The temporary collection is also removed. This smoke test passed; no customer document is used as its fixture. Current global development caps still apply, and this is a smoke test rather than a representative accuracy benchmark.

The first queued customer PDF exposed a parser IPC delivery bug: the child could exit/disconnect before a larger extracted-text response reached its parent. The child now retains its listener until processing ends and awaits send completion before disconnecting. A synthetic 60-page regression verifies complete delivery of a payload larger than 128 KB. After the fix, the originally queued 10-page PDF was retried under its original member permissions and became ready with 14 chunks. The queued deletion was also physically purged. Recorded list-price usage estimates for live verification plus that ingestion totalled US$0.000680 (Voyage US$0.000341; OpenAI US$0.000339); these are metered estimates, not an invoice.

In the customer UI, **En cola** means the upload is stored and its ingestion job is waiting for the worker. **Procesando** means a worker has claimed it and is extracting, chunking and embedding. **Listo** means its complete active version is searchable. **Sin procesar** means an older upload has not been queued; its authorized curator can select the processing icon. A document in En cola is not yet part of retrieved knowledge. Worker availability, lease retries and provider budgets can affect wait time.

## 31. Local frozen-candidate chat preview — 2026-09-14

**Owner-approved sequence:** build the minimal exact-candidate chat preview before evaluating representative RAG quality. Develop locally on the Mac first, evaluate the approved representative dataset through that same execution path, then verify an isolated VM staging deployment. Staff evaluation/production approval, controlled production deployment and the everyday customer Chats module follow. The representative dataset is still owner-supplied work; synthetic smoke tests do not establish retrieval accuracy.

**Navigation decision:** customer `Chats` will be one workspace sidebar destination, with a searchable conversation list and searchable agent picker. Each agent can have multiple titled conversations; do not create fifty permanent sidebar agent entries. Agent detail provides a second entrance to the same conversation experience. `Probar versión` stays within agent authoring, visually distinct from production chat. Everyday Chats may become the workspace landing page once deployed agents are usable; use-only users do not need authoring access. Transcript access remains independent of management permissions.

### 31.1 Implemented local preview boundary

Migrations `202609140008_previews` and `202609140009_preview_followups` add the narrow customer-owned `agent_previews` slice (35 implemented tables; the full target remains 72), immutable code execution manifests, preview-scoped queue turns and content-free agent/preview usage attribution. Existing authoring-only releases remain non-executable. Compatible later code releases may implement the same template/configuration contract with their own Git commit; a template's original Git commit is not required to equal every compatible code release. Publication verifies the unchanged platform policy. Existing candidates never silently switch code; freeze a new candidate with the executable release.

The local preview pins an immutable code artifact and frozen configuration. It does **not** yet create the target `deployments` record or install a systemd service; target `agent_previews.deployment_id`, staff initiators and delegated support previews remain closed. Local artifact identity is read from the pinned code release's execution manifest. The formal host/deployment lifecycle is a subsequent VM staging slice, and local preview success cannot unlock production approval.

The restricted worker verifies the installed artifact manifest digest, exact Git identity and every executable/policy file hash before provider work, then starts one trusted runtime child per turn over private IPC. The child receives no database or provider credentials and exposes no network listener. The broker binds operations to the leased job and provides one fixed-model generation capability. This process boundary is not an OS sandbox; customer executable code is unsupported. Each child has a 192 MiB V8 heap limit and a 60-second deadline; the existing worker renews the fenced database lease.

The runtime validates the exact PostgreSQL canonical JSONB strings and hashes for content, requested access and generated asset manifest, verifies each prompt/skill byte hash and the composed prompt hash, then applies the frozen customer instructions and selected reference skills. Model settings are pinned in the code artifact: `gpt-4.1-mini-2025-04-14`, temperature zero, 1,000 maximum output tokens, Responses structured output, no tools and `store:false`. The broker fixes these provider controls independently. Current official references: [model and pricing](https://developers.openai.com/api/docs/models/gpt-4.1-mini), [structured output](https://developers.openai.com/api/docs/guides/structured-outputs). Input/output list-price estimates retain the existing US$0.40/US$1.60 per million token rates; they are not invoice evidence.

Starting a preview explicitly creates a reduced, private, read-only staging authority for that member and candidate; a requested production snapshot alone is not an active grant. Each operation rechecks current authoring permission, code availability, all selected collection read permissions, source authorizer authority, the source's staging/upload/collection-access properties and frozen source definition hash/revision. Retrieval materializes eligible sources before ranking. Sources added after freezing are excluded; approved document refresh within an unchanged source may advance. No external actions, connectors, group audience, standing authorization or production access are enabled.

Previews expire after ten minutes, allow ten serialized turns and have a US$0.25 ceiling. Reservations count against the **existing accumulated** global Voyage US$10 and OpenAI US$25 development allowances; setup and migrations never reset or duplicate them. The per-preview ceiling is an additional bound, not new funding. Full customer workspace/agent budget periods remain required before hosted customer runtime launch. Unknown provider outcomes keep conservative reservations. Preview turns are not retried automatically after provider failure or lease loss; request UUIDs prevent duplicate UI submissions.

The stateless runtime reconstructs prior successful, currently authorized question/answer pairs explicitly. Retrieval uses the current question plus up to two preceding user questions for semantic follow-up context; current passages remain the only factual evidence. Answers must cite supplied passage IDs or indicate insufficient evidence. This reconstruction covers this protocol's entire conversational state because there are no SDK sessions, tools or hidden memory; future SDK recovery requires its own checkpoints and restoration verification.

The authoring preview UI lives at `/agents/[id]/preview`, with a frozen-version selector, explicit start/finish, message composer, processing/error states and expandable cited passages. Only the initiating member can read the transcript, even if another member maintains the same agent. Every poll is authorized and no-store; a revoked or expired response clears rendered messages. Finishing scrubs content immediately. Document removal invalidates and scrubs all workspace preview turns as part of the existing conservative knowledge-result invalidation. Source/permission changes suppress prior answers before reuse/delivery. Worker maintenance removes expired/cancelled content; while the worker is stopped, expiry still denies reads but physical cleanup waits. Provider logs and managed backups retain their separate policies (§30).

### 31.2 Local operation and VM staging layout

`pnpm setup:preview` packages the clean, committed sibling `agentonic-runtime` checkout into ignored `.local/runtime/<manifest-sha256>/` and registers that exact artifact for the two configured nonproduction workspaces. Shared bundles contain platform code/policy only. The worker uses that directory by default; `AGENTONIC_RUNTIME_ROOT` can select a separately provisioned artifact root. `pnpm dev` runs both apps and the worker; check processes before starting another worker. No extra runtime listener is needed for this local IPC adapter. `pnpm preview:check-live` is an explicit paid synthetic smoke check, excluded from routine CI; it preserves provider usage when removing fixtures.

The read-only VM inventory found empty `/opt` and `/srv`, no Agentonic checkout in the inspected application/home paths, no running Agentonic/Corby system service and no application listening port. Approximately 29 GiB memory and 121 GB disk were available at inspection. This is an inventory observation, not a production capacity or isolation assessment. No VM mutation occurred.

The planned systemd layout is:

```text
/opt/agentonic/platform/releases/<platform-commit>/
/opt/agentonic/runtime/releases/<runtime-commit>/
/opt/agentonic/instances/<workspace-id>/<agent-id>/staging/
  releases/<deployment-id>/{manifest.json,runtime,prompts/,skills/}
  current -> releases/<deployment-id>
/etc/agentonic/staging/{customer.env,admin.env,worker.env,agents/<agent-id>.env}
/var/lib/agentonic/staging/{worker/,agents/<agent-id>/}
/var/cache/agentonic/staging/
/etc/systemd/system/agentonic-{customer,admin,worker}-staging.service
/etc/systemd/system/agentonic-runtime@.service
```

`runtime` refers to the exact immutable shared code release; generated per-agent assets have restricted ownership. Logs use the journal with content/secret redaction and bounded retention. Separate service identities enforce read-only releases and private mutable state; production later has independent activation paths, secrets and state. Required recovery state must also survive VM loss. Deploy versioned artifacts into new directories, never synchronize a working checkout over a live release. Preparing, activating, reporting exact code/configuration hashes, checking health, reconciling interruptions and restoring an eligible prior release follow §11. An IPC local preview does not substitute for those VM acceptance checks.

**Verification:** all 176 platform tests and seven runtime tests passed, alongside Prisma generation/validation, typecheck, lint and version consistency. PGlite was upgraded to 0.5.8 with its separate pgvector 0.0.9 package after the old engine trapped in WASM on mixed preview/ingestion workflows. The suite uses normal planner settings and executes the full authorization SQL; no checks or indexes were removed. Migration 9 qualifies the prior-turn payload column, preventing the PL/pgSQL payload parameter from suppressing follow-up retrieval context. Nine migrations are applied to nonproduction; applied migrations were not edited.

The live synthetic check verified ingestion, exact frozen execution after editing a newer draft, a cited expected fact, a follow-up, abstention and cross-workspace transcript isolation through restricted credentials. Rapid earlier runs encountered provider failures and retained their unknown reservations; a paced run completed and removed all synthetic documents/agent/preview records while preserving usage. Browser review covered private conversation resumption, citations, failure feedback, finish-and-clear behavior, the corrected Spanish breadcrumb and a 390px mobile viewport without horizontal overflow. This establishes functionality, not representative RAG accuracy. The Mac worker remains the execution host; VM deployment and the representative dataset evaluation are still pending.

## 32. Collection deletion and empty Knowledge state — 2026-09-14

Migration `202609140010_collection_deletion` adds a customer-only `collection.remove` command through the existing verified identity boundary. It requires current collection curate access. The transaction takes the same workspace write lock as uploads and authoring mutations, then checks the current inventory: if any undeleted document object exists (including an unfinished upload), the supplied confirmation must exactly match the collection name. The browser cannot bypass this rule by reporting an empty collection. A stale empty dialog receives a confirmation-required response and displays the name field.

Deletion withdraws the collection immediately, marks all its document objects for deletion, clears active versions/chunks/embeddings, fences ingestion leases and invalidates workspace retrieval answers/private previews under the existing conservative deletion policy. A deduplicated durable purge job per object removes Storage files and associated document/source records; cleanup survives removal of the collection's access. The Knowledge footer counts pending cleanup for the collection's active owner/curators. Unrelated collections and their documents, immutable candidates/submissions, content-free audit and accumulated provider usage remain. Existing frozen references to the collection fail live authorization; editing a draft must remove that unavailable source before freezing another candidate.

The collection row becomes a non-content tombstone (`archived_at`, generic deleted name, cleared description and a generated deleted slug), preserving relational provenance and freeing the original slug. There is no restore action. Future connectors or shared document-object references must extend this deletion path before they are enabled.

The Spanish collections table exposes an accessible delete icon only to curators. Empty collections have a simple confirmation; populated collections require typing the exact name before the destructive button enables. Pending actions cannot be duplicated or dismissed. Stable collection row IDs and column renderers preserve dialog input during background refreshes. Collection/search component keys have distinct prefixes, and search resets when the collection inventory changes as well as document content/state, including the zero-document state. The collection skeleton includes the new action column.

Verification: all 181 platform tests, Prisma generation/validation, typecheck, lint, version consistency and 13 skeleton checks passed. Regression cases cover exact-name enforcement for pending uploads/stale empty views, current curator versus revoked/read-only/staff/cross-workspace access, ingestion fencing, preview invalidation, deduplicated purge and preservation of unrelated documents/provider totals. Browser checks covered both dialogs, incorrect/exact input, desktop/mobile layout and the zero-document page with no console errors. A synthetic Storage file was physically purged by the existing worker, and temporary collection records were cleaned up without AI calls. Ten migrations are applied to nonproduction; earlier applied migrations remain unchanged.

## 33. Customer version preparation and review — 2026-09-15

This supersedes the engine-selection and two-step freeze/review UI in §29. Following visual review, the customer sees two cards arranged side by side on desktop and stacked on smaller screens: **Versión actual** presents the latest prepared candidate (not a production deployment), its version number, originating draft revision and preparation date; it explicitly says when none exists. Its **Probar agente** action opens that exact candidate; it reads **Continuar prueba** while the current member has an authorized, unexpired test for it. The label returns to **Probar agente** when that session expires. **Enviar a revisión** opens a dialog containing the optional note and explicit consent, keeping the summary card compact. Unavailable historical candidates remain visible with disabled testing; previously sent candidates link conceptually to their submission history rather than permitting duplicate submission.

**Nueva versión** appears first (left on desktop, above on mobile), followed by **Versión actual**. The empty current-version state centers a decorative 48px open-package icon, its empty-state title and a short instruction. The preparation card omits the preview limits/deployment disclaimer paragraph; the preview screen retains its time, message and per-test cost limits, but omits the provider/development-budget paragraph and the return-to-agent reminder/button below the settings card. The standard back navigation remains available. **Nueva versión** always presents the saved draft revision and **Preparar versión**. Its draft summary is framed as a package with a closed-package icon, a monospace revision label and status in the header, separated from the description below. A prepared **Versión actual** uses the same package frame: version and originating revision beside the package icon, status in the header, then the preparation date and saved-change summary. Actions remain below the frame. If the current saved combination already exists, it shows **Sin cambios nuevos**, explains that the customer must edit and save changes, and disables duplicate preparation. New saved changes enable preparation subject to the existing valid-draft and collection-access checks. Unsaved edits or an open skill dialog block preparation, navigation and submission so the form is not silently discarded. Review consent remains required inside the submission dialog, which cannot close during submission. A prepared candidate is never labeled evaluated or approved merely because its test was opened.

Agent creation exposes only name, identifier and description. Template/runtime choices are internal: both creation availability and the creation command resolve the template behind the latest published preview-capable code release currently authorized for the verified workspace. Selection orders by publication time and ID, not version-string sorting. The mutation resolves the choice afresh in its identity transaction and the database command rechecks current grants and creation rights; client template/runtime/owner overrides cannot select another default. If no eligible release exists, creation is unavailable. The old workspace catalog contains one row per code release and may repeat template IDs; it must not be rendered as a customer template selector. Existing agents and frozen configurations are not rewritten when a newer default is published.

Runtime selection is server-owned. Within the verified detail transaction, read only compatible template releases that remain authorized, are not retired, and advertise preview contract 1. Prefer the agent's newest frozen candidate's still-eligible runtime, then earlier eligible candidates, then the latest eligible published code release. The customer cannot submit an engine choice through the preparation action. This policy uses the existing staff-published code catalog and workspace grants; a dedicated admin runtime-assignment UI remains future work. No compatible runtime produces a clear unavailable state, with no fallback to the historical authoring-only release. Existing candidates remain immutable.

The **Preparar versión** action checks the expected saved revision and reuses an existing exact revision/runtime candidate or freezes that pair using the existing idempotent database command. It stays on the agent page and never starts a preview. Testing is a separate action requiring an explicit candidate; it cannot create or substitute a version. **Probar agente / Continuar prueba** starts or resumes the private preview for that exact candidate and verified member, then returns a link identifying both candidate and preview. No provider turn is sent automatically. Existing ten-minute, ten-turn and US$0.25 preview limits and cumulative development budgets remain unchanged; resuming an active preview never renews its expiry or resets usage. An expired preview requires a fresh session under the same limits.

Migration 11 adds content-free `active_agent_previews(agent)` discovery, callable only by the restricted customer role. It checks the verified workspace/member, current authoring permission and existing full preview authorization, returning only IDs and expiry for that caller's active sessions. Direct table access remains revoked. Agent detail uses this metadata for the test button; deep-link restoration uses the same boundary before requesting the authorized transcript. Preparation, discovery and page reads do not start tests or reserve provider spend.

A preview deep link restores state only after matching workspace, agent, candidate, preview and current member, followed by the existing live preview authorization check. Invalid candidate links do not silently select another version. Reading the page does not start a session. Standard back navigation supports the review flow; every submission still identifies its exact candidate, current draft revision and separate seven-day review consent. The current-version card automatically offers the candidate matching the saved draft for submission; it does not silently submit an earlier test after the draft changes. Submitted candidates remain visible as already sent and are not offered for duplicate submission.

Customer prepared-version labels use an ordinal derived over all of the agent's immutable configuration releases ordered by creation time and ID (including historical authoring-only releases), independent of the saved draft revision. The card shows the originating draft revision and creation date; the preview picker uses the same prepared-version number. These are presentation metadata, not a new schema field or a changed code/configuration identity. The **Propuestas y comentarios** section presents submissions as table rows with proposal, status, comments and actions columns. Active submissions use an accessible trash-icon button to withdraw, retaining explicit confirmation and historical records. The editor skeleton mirrors the two summary/action cards and proposal table; the review dialog is absent during initial loading. The preview skeleton omits the removed reminder and secondary return action.


### Staff review queue — 2026-09-15

The admin review queue defaults to all discovered workspaces with submissions. A shared Filtros card follows the Acachuchazo/Corberó pattern: title, description, labeled workspace select defaulting to Todos los espacios, and Limpiar. An explicit workspace URL filters the result; clearing restores the global queue and resets table search. The server discovers permitted workspaces, reads each queue in a separate verified transaction, and attaches its trusted workspace ID/name to every row. Failed reads fail the listing instead of returning partial results; no database permissions or migrations change for aggregation.

The six table columns are a leftmost ellipsis action, Agente, Espacio de trabajo, Correo electrónico, Revisión # (submission number), and Versión # (prepared configuration sequence, ordered by created_at/id consistently with the customer editor). Usuario and ID de usuario are omitted. The agent name uses the blue underlined link styling; activation and the menu's Ver revisión both invoke the same audited server action using that row's workspace. Ver usuario and Cambiar estado remain visibly disabled as Pronto while their respective page/action are deferred. Closed or unauthorized revisions have no active content link. State tabs replace the status column; search covers displayed text/version fields. The loading state mirrors the filter card, tabs and six columns.

Migration 12 adds `review_queue()` for verified active staff in an active selected workspace and retains workspace discovery for closed submissions. This is operational metadata across submission states, including expired/revoked consent; no prompts, notes, requested-access snapshots or documents are returned. `canOpen` requires an active submission, unexpired consent and current submitting-member authority; the existing audited open action remains the authoritative content-access check. History visibility does not revive a grant, approve a version or deploy it.

Supabase remains the source of confirmed email addresses. `node scripts/setup-review-identity.mjs` installs a narrowly scoped Auth-owned email bridge before `pnpm db:migrate`; only the migration authority can execute it. Application roles cannot query Auth or call this arbitrary-ID helper. The migration-owned review function resolves only submitters in its authorized workspace. Emails are read live, never copied into application tables, logs or fixtures; unavailable/deleted identities are handled explicitly. No new table is introduced.

## 34. Exact-version evaluation and approval — 2026-09-15

Migrations `202609150013_evaluations` through `202609150015_evaluation_retention` implement the first formal evaluation/approval slice. Development and both web apps remain on the Mac; a dedicated **Azure staging evaluator** executes the frozen runtime artifact. Approval never creates a production deployment or effective production grants. The general deployment/health/rollback lifecycle and customer chat remain later work.

### Workflow and evidence

1. A scoped staff reviewer proposes 3–20 cases, an execution environment and a US$0.01–1 ceiling. Each case includes a question, expected answer for human review, necessary/excluded phrases and whether to abstain. Both factual and no-evidence cases are required. Cases, grading rules, code release, configuration and requested access are hashed and frozen.
2. The original submitting customer explicitly authorizes that exact plan and knowledge scope. Existing configuration/knowledge-metadata review consent does not authorize document execution. Cancellation is available from the customer agent page, including after evaluation. Permissions and consent are checked again for each worker operation and read.
3. A separately credentialed evaluator claims only its registered environment and runtime hash. It uses the existing retrieval, provider broker and isolated per-case runtime process; configuration/access JSON comes from the frozen candidate, never the current draft. Cases are independent, with no cross-case history. The database grades phrase presence/absence, cited-source membership and abstention. Staff can inspect each actual answer and currently authorized cited excerpts.
4. Only complete passing **Azure staging** evidence, an unrevoked measured worker, current source versions/rights, live consent and an administrator/operator can unlock **Aprobar versión**. The staff member must attest to reviewing the answers and provide a conclusion. The immutable decision binds the evidence and entire requested-access hash. Its maximum activation window is 24 hours, bounded by the evaluation's expiry. `version_approval_valid` checks subsequent validity, including later decisions and current rights; status alone is insufficient.
5. The original approver or another administrator/operator with a historical scoped review grant can revoke approval from the approved row's menu. Revocation needs no renewed private-content read. Production activation remains closed.

Phrase matching is a deterministic regression check, not a semantic-quality score. Expected answer text is for human assessment. Representative customer acceptance cases still require review and authorization; synthetic verification establishes infrastructure behavior only. A reusable dataset registry and broader graders in the DBML remain the fuller target; this slice freezes a versioned dataset directly on each evaluation run.

### Isolation, costs and retention

`agentonic_eval_local` and `agentonic_eval_azure` are distinct restricted database roles. They can claim/work evaluations only; they receive no web, Auth, Storage, bootstrap or migration credentials. Database worker registrations bind environment, runtime and evaluator hashes to a measured installation and expire after seven days. A worker cannot declare its own Azure provenance. Registrations are immutable except revocation; renewal creates a new registration after re-verification.

The evaluator reserves and settles through the existing provider ledger. The US$10 Voyage and US$25 OpenAI aggregate allowances and accumulated commitments are preserved. Per-evaluation limits are additional ceilings. Outstanding reservations block successful finalization; cancellation, interruption and unknown provider outcomes never refund unknown usage. There is no automatic paid-case retry. A lost lease closes the run as an error. Azure spaces cases by 31 seconds for low development request-rate limits; other concurrent workloads can still exhaust a provider quota and fail the run safely.

Evaluation authorizations last at most seven days and never outlive review consent. Revoked consent or source rights immediately suppress answers. Evaluator maintenance erases cancelled/expired case text, answers and source excerpts while retaining hashes, outcomes, decisions and cost metadata. If the evaluator is offline, reads still enforce expiry; physical cleanup resumes with a registered worker. Provider retention and managed database backups follow their separate policies. Source refresh invalidates approval against the old cited document version; it cannot silently substitute newer evidence.

### Operation

- `pnpm setup:evaluation` provisions only evaluator roles for the explicitly configured nonproduction project. Apply Prisma migrations afterward.
- `pnpm package:evaluation` creates a fixed evaluator bundle and input-hash manifest under ignored `.local/evaluation/releases/<worker-sha256>/`. The manifest records the base Git commit and current input hashes; it does not pretend uncommitted platform work is committed.
- `node scripts/deploy-evaluation-staging.mjs --deploy --runtime-sha256=<registered-artifact-hash>` installs the isolated evaluator on `vm-agents-01`. The runtime must be the existing frozen artifact, not a rebuild of the same commit. The tool verifies Node's official archive checksum, root-owned bundle hashes, service identity, secret-file access and process restart. `--replace` explicitly installs/re-verifies a replacement. Follow with `node scripts/register-evaluation.mjs` (or `--replace` for new registration); never rotate a registration during active evaluation.
- Azure paths: `/opt/agentonic/evaluation/releases/<worker-sha256>/`, `/opt/agentonic/runtime/artifacts/<runtime-sha256>/`, `/opt/agentonic/node/v22.23.2/`, `/etc/agentonic/evaluation-staging/worker.env`, and `/var/lib/agentonic-evaluation-staging/`. Service: `agentonic-evaluator-staging.service`; OS user: `agentonic-eval`. Releases are read-only; the environment file is root-only and supplied by systemd. No application listener is opened. No existing web, ingestion or Corby service is replaced.
- `pnpm dev:evaluation` runs the separate local evaluator profile. It is optional and is not added automatically to `pnpm dev`. Local results cannot satisfy Azure approval.
- `pnpm evaluation:check-live` is an explicitly paid synthetic smoke check outside CI. It creates an isolated synthetic workspace, ingests a synthetic document, evaluates three cases on Azure, exercises the approval/revocation boundary and retires the fixture workspace after document purge. Immutable diagnostic history and usage remain; no real customer agent is approved by this script. `.local/evaluation/live-report.json` stores the content-free receipt. Interrupted fixtures use `node scripts/check-evaluation-live.mjs --cleanup` before another run.

**Verification checkpoint:** the live Azure synthetic check passed both cited facts, explicit abstention, exact-evidence approval, subsequent validity and immediate revocation. The document was physically purged and its synthetic workspace retired; content-free history and costs were retained. Earlier provider-failure reservations were preserved. Node v22.23.2 was obtained from the official Node distribution and verified against its published SHA-256. The currently registered runtime is the original frozen preview artifact; a rebuild with different bytes was rejected rather than substituted. Automatic grading remains insufficient evidence of Corby SAT's real-world quality.

Migration `202609150016_candidate_creation_clock` also makes new candidate timestamps reflect the actual freeze instant, so multiple freezes in one transaction do not get a random UUID-based version order. Historical candidates remain unchanged.

## 35. Customer-led automatic review — 2026-09-15

Migrations `202609150017_automatic_review` and `202609150018_review_outcomes` supersede the manual case-writing workflow in §34 for new reviews. Existing v1 evaluations remain accessible as historical evaluations. The web apps remain local; AI preparation, frozen-agent execution and semantic grading run on the dedicated Azure evaluator. There is no customer environment selector.

### Product flow

1. After submitting a version, the original customer authorizes AI preparation and a **single total limit** (US$0.05–1). Preparation reads only that frozen version and a bounded sample of currently authorized knowledge. It suggests distinct business situations and expected behavior, with source references or a request for missing business information. It never substitutes invented business rules for missing facts.
2. The customer can edit questions/expectations, save notes, add situations, or exclude suggestions with an explanation. Saves append immutable numbered revisions; stale edits fail with a conflict. Generated provenance cannot be rewritten. Confirmation freezes the current criteria revision, notes, code/configuration/access tuple and total limit, then queues evaluation. Platform checks are added by the database and cannot be edited or excluded.
3. The measured Azure evaluator executes each case against the existing frozen runtime. An isolated, tool-free model request compares actual responses with the confirmed expectations and authorized evidence. It evaluates meaning, groundedness, permitted behavior and uncertainty; phrase lists are removed. Customer text, expected answers and retrieved documents are all untrusted data to the grader. Missing or conflicting evidence yields uncertainty instead of manufactured ground truth.
4. Routine, read-only platform agents can receive automatic approval only when every business/platform case passes with high confidence, no suggested case was excluded, all graders report routine scope, usage is settled under the total ceiling, source rights remain live, and exact Azure evidence passes the existing approval gate. A policy actor (`readonly-review-v1`) is recorded explicitly with `humanReviewed: false`. Sensitive, uncertain or excluded-case reviews require staff attention; clear failures produce actionable customer feedback. A staff exception can approve only an otherwise fully passing evaluation, with a real review attestation and conclusion. Failed platform checks cannot be waived through that action.
5. The staff page uses the customer's centered, single-column settings layout: system instructions, skills and requested knowledge first, automated review next, optional historical evaluations, and the always-visible **Atender revisión** card last. Resource cards reuse `AgentSettingsCard` and the customer's resource icons; the loading state follows the same stack. Customers see the outcome and adjustments, with the full test report optional. The live staff review workflow ends when the submission closes. Approved submissions link to the separate read-only receipt described below; other closed submissions show their closed outcome and the queue link. Approval is separate from deployment, retains its maximum 24-hour validity window, and can be revoked by any current administrator/operator without reopening private content.

### Evidence and operational boundaries

**Per-situation customer review (migration `202609150019_criterion_decisions`):** the customer agent page has **Configuración** and **Propuestas** tabs, retaining the editor while switching and preserving the selected tab in the URL. The proposals table shows reviewed/total criteria, evenly distributed data columns and a leftmost ellipsis menu for reviewing the version, cancelling authorization and withdrawing the proposal. Preparation, criteria and results are available through that row’s review dialog; there is no duplicate review card below the table. Withdrawal retains the frozen version and audit history. Customers explicitly choose **Aprobar situación** or **No aplica**. No aplica opens a foreground reason dialog with Cancelar/Confirmar; cancelling leaves the criterion unchanged, and failed saves retain the reason for retry. Decision buttons show an inline spinner while saving. Approval is disabled for an already approved criterion until an edit resets its decision; edits reset the situation to pending and new situations increase the denominator. **Descartar situación** removes customer-added situations before confirmation, including previously saved additions; the next save records the revised set. Generated suggestions remain in the review and require **No aplica** with a reason to exclude them. The wizard stacks the message and expected-response fields at full width, retains reviewed/total progress, and only shows final authorization once every situation is reviewed. Each saved decision is stored as `reviewDecision` in the existing immutable, numbered criteria revisions. Confirmation requires every situation to have a decision and at least one included, complete expectation. Generated criteria cannot pre-populate customer decisions. Existing confirmed snapshots remain unchanged; unconfirmed criteria require explicit review. The rationale is a compact whitespace-normalized excerpt, with the complete rationale and authorized sources in a separate dialog. No additional AI request is made to rewrite it.

**Pre-evaluation summary (migration `202609150020_review_summary`):** after every situation has a saved decision, the dialog switches to a plain summary with the agent name, exact candidate version number, and a situation table showing message/expected-response edits, notes and the customer decision. Edit indicators compare current text with the immutable generated proposal; customer-added situations are labelled separately. Summary reads return only the original comparison fields and metadata under the existing live customer/staff authorization and source checks; revoked access suppresses them. Situation links reopen the wizard for corrections, which reset consent and require reapproval after edits. The wizard header and navigation controls are absent from this view; a final footer row offers **Agregar situación**, which opens the new situation for review. The summary identity fields sit side by side. In situation details, navigation sits beside the situation number and status; the title shows the reviewed percentage. **Ver resumen** is an outlined icon button at the left of the footer when all situations are reviewed, and approval/exclusion actions sit at the right. This footer uses the same background as the dialog. A saved **No aplica** decision disables its button until an edit resets the decision; its reason appears in a read-only field matching the notes layout. Budget consent remains in the summary; the details header omits the budget line. Final consent and submission appear only in the summary; all-excluded reviews remain blocked until at least one situation is approved. No additional AI call is required.

**Approved-version receipts (migration `202609150021_approved_receipts`):** the approved queue’s agent link and **Ver revisión** action open `/submissions/[id]/receipt`. The page reuses the review’s stacked resource cards, with frozen configuration, requested collection metadata, confirmed criteria (including exclusions/notes), the exact evaluation results and approval actor/timestamps. It contains no review, evaluation, editing or deployment controls. Approval validity is computed separately from the recorded approved status; expired or invalid approvals are labelled **No vigente**. Returning to the queue selects **Aprobadas**.

The admin-only `approved_review_receipt` function verifies active staff, active transaction-scoped workspace, approved submission, latest approval and its exact configuration/evidence tuple. Private content uses a separate version-3 support grant scoped to `receipt` for that submission and actual staff identity, bounded by the customer's original review consent. This grant cannot authorize `can_review`, commands, evaluations or deployment. Existing revoked grants are not silently renewed. Expired consent, lost member/collection access or retired configuration suppress private configuration, notes and approval feedback; expired/revoked evaluation consent, changed sources or scrubbed records additionally suppress criteria/results. Operational receipt metadata remains available to active staff in the workspace without claiming the underlying approval is valid. Every receipt read is audited without logging content. No retention extension or source-document access is introduced, and no worker deployment is required.

**Customer proposal receipt:** **Revisar versión** retains the **Revisión de la propuesta N** dialog. Completed and other non-editable preparations use stacked receipt cards for the exact candidate number, authorized budget/use, saved situations and exclusions, every available test result, and recorded proposal feedback. Criteria and result frames are shared with the admin receipt, with customer-facing wording and existing authorized evidence disclosures. Editable ready criteria still open the interactive wizard; preparation and cancellation keep their existing controls. The view uses the existing scoped authoring/review reads, respects their redaction and current approval status, and introduces no new data access, approval or deployment action. It summarizes the review; it does not substitute the current editable draft for frozen version content.

Staff see a **Decisión del cliente** column for these criteria. **Registrar decisión** stays disabled until the latest review has customer confirmation and a completed evaluation with live authorization and sources. A database guard enforces the same rule under the workspace lock for direct calls; a newer pending review cannot be bypassed with an older result. Staff can record feedback/rejection for completed results needing attention. Automatic approval and exceptional approval retain their separate existing controls.

`evaluation_preparations` binds explicit customer preparation consent, generation provenance, sampled source hashes, risk, mutable pre-confirmation criteria, total committed usage, worker identity and confirmation. `evaluation_criteria_revisions` preserves each saved revision and its content hash. The confirmed execution uses `grounded-review-v2`; individual results include the structured assessment, and the evidence hash includes each distinct assessment/check set. Source freshness is checked at preparation, editing, confirmation, each worker operation, result reads and approval validity. Cancellation/expiry suppress content immediately and erase generation, saved revisions, cases, answers and explanations during maintenance; usage, hashes and decisions remain.

Preparation and evaluation share the customer ceiling, in addition to existing global provider caps. Generation and grading use the pinned `gpt-4.1-mini-2025-04-14` model with structured output, `store: false`, no tools and separate platform instructions. Known usage settles once; incomplete structured outputs still settle known usage, while unknown outcomes retain reservations. Paid requests are not automatically retried. Preparation leases expire after 90 seconds without heartbeat and have a five-minute maximum; execution keeps the existing 30-minute bound. Only an attested Azure worker with `reviewProtocol: 2` may execute the new protocol; the ordinary Mac worker and the optional local evaluator cannot prepare customer reviews or supply automatic approval evidence.

Preparation currently samples at most 24 chunks, interleaved across documents. This is a representative review, not exhaustive corpus coverage or a guarantee of real-world quality. Classifiers/graders are fallible; uncertainty and sensitive scopes go to staff. Broader production launch should include domain-specific calibration and outcome monitoring. No production deployment, effective production permission, website hosting, billing integration or notification delivery is added by this slice.

Operations: apply the migration; deploy the new fixed evaluator bundle with `--replace` and the **existing registered runtime hash**; register its measured protocol-2 attestation with `scripts/register-evaluation.mjs --replace`. Replacement refuses queued/running execution or preparation work. Never rebuild a frozen customer runtime in place or reset provider allowances. `node scripts/check-review-flow-live.mjs --live` uses synthetic knowledge in an isolated nonproduction workspace to verify AI generation, persisted customer notes, semantic evaluation, policy approval and revocation; `--cleanup` retires an interrupted fixture. Its content-free receipt is `.local/evaluation/review-flow-report.json`. The previous v1 smoke script remains for legacy protocol verification.

Migration 18 accepts properly grounded abstention in customer-defined cases without fabricated citations, while retaining semantic/expectation/safety checks. Outcome reads reflect current manual or policy approval validity and show revocation/expiry explicitly. Routine classification distinguishes informational retrieval (including documented delivery/warranty facts) from professional advice or execution; rejecting a synthetic platform attack does not itself make the agent’s purpose sensitive.

**Verification checkpoint:** 264 tests pass, including exact policy approval, manual exceptions, missing customer input, optimistic edit conflicts, uneditable provenance/platform cases, cancellation/retention, combined spending caps, stale-source denial and uncertainty routing. Prisma generation/validation, typecheck, lint and 13 skeleton baselines pass. A browser fixture verified customer notes, exclusion reasons, confirmation controls and the corresponding loading layout; the temporary route was removed. The actual staff revision's new state was read through its scoped admin role. The updated measured Azure worker completed a synthetic five-case review with persisted customer notes, automatic policy approval (`humanReviewed: false`), validity checks and immediate revocation; its document was purged and workspace retired. The prior synthetic run that required attention retains its recorded result and usage. No customer agent is part of these fixtures.

## 36. Approval renewal and private staging activation — 2026-09-16

Migrations `202609160022_approval_renewal` through `202609160027_staging_agent_listing` connect the exact-version review flow to bounded local and Azure staging operation. Production remains disabled. This supersedes the earlier blanket statement that *all* post-approval deployment is absent; the production lifecycle, public channels, tools and general customer runtime remain outside this slice.

**Review and activation are separate facts.** The approved queue shows authorization validity and deployment state. Receipts preserve the immutable approval and report whether it is expired, superseded, missing consent, backed by changed sources, backed by expired evaluation evidence, or otherwise unauthorized. Staff can request renewal without reading private content. The original submitting customer can authorize a new review of the same frozen candidate with a new explicit preparation/evaluation ceiling. The new submission records its predecessor; the first submission, decisions and accumulated usage are not rewritten. Only one successor and one open review per candidate are allowed. New criteria are prepared and require the existing per-situation customer confirmation before execution; an old approval timestamp is never extended.

**Staging operating consent.** After a valid approval, the original customer can authorize private read-only staging use locally or on the measured VM host, for at most seven days and US$0.05–1 total across that deployment's conversations. An active administrator/operator separately queues activation. Activation rechecks the exact approval, initiating staff's current authority, current customer/source rights and measured code at installation and observed readiness. Approval expiry is an activation deadline: a running release uses its independent operating consent rather than requiring daily reapproval. Revocation, offboarding, retired/revoked code, source-definition changes, changed cited evidence, operating-consent expiry and expired/revoked host attestation deny work immediately. Host attestations last seven days and require re-verification. Customer consent, host attestation and provider funding are not renewed by a restart.

**Installation and recovery.** `runtime_hosts`, `deployments` and the `agent_environments` current pointer record the host, exact candidate/approval, immutable manifest, initiating actors, desired state, observed state and heartbeat. A deployment controller with a restricted deployer database role prepares fixed release directories and starts the verified broker; a distinct runtime role plus a deployment-bound secret authorizes only that service's operations. Azure uses a narrowly scoped root controller with fixed path/unit operations and a systemd dynamic user for each installed broker. Customer text is never executed or interpolated into commands. Private assets and credentials are root-only; systemd provides each service its own configuration/asset credentials. Child model runtimes receive no database/provider secrets. No public agent listener is opened.

The old release continues serving while a candidate is prepared. Only a broker that verifies its artifact, manifest and generated assets can acknowledge readiness and become the current database deployment. The controller reconciles the filesystem `current` link to that observed record. Failed preparation leaves the previous current release intact. Superseded services immediately lose database execution authority and are stopped by the controller. Process restarts revalidate the same bytes and current consent; lost/expired turn leases fail without retrying paid work. Unknown provider outcomes retain their reservations. A later process failure is shown as offline after heartbeat expiry, with bounded systemd restart attempts; it does not fabricate a successful rollback or reactivate an expired approval. Replacing an installed broker/runtime while deployments are active is refused. *(Updated 2026-10-05: runtimes now install side by side; only broker replacement is still refused. See §40.)*

**Private Chats.** The workspace has one Chats destination with conversation/agent search, an agent picker and multiple titled conversations. Only the member who explicitly authorized the deployment can invoke or read these staging conversations, and live invoke/source permissions remain required. Admin review/receipt privileges do not expose transcripts. Turns pin one deployment, serialize within a conversation and deduplicate request IDs. The broker uses the existing frozen protocol-1 runtime, fixed model, retrieval and accumulated provider ledger. Conversation history is explicit and bounded to the nine latest successful turns for model context; there is no hidden SDK state or persistent agent memory. Conversations last at most seven days, further bounded by workspace retention and deployment consent; each accepts at most 100 turns. Closing erases message content immediately. Invalid/expired content is denied on reads even if the host is offline, then physically scrubbed when the controller resumes. Content-free usage remains.

This is a narrow private staging chat slice (`staging_conversations`, `staging_turns`), not an implementation claim for the full contact-based conversations/sessions/tools model in the target DBML. The deployment ceiling and existing aggregate provider caps remain conservative; production workspace budget periods and the fuller transcript/access model must precede general hosted launch.

**Current file layout and ownership.** The runtime Git repository remains shared platform code. Its existing approved artifact is reused byte-for-byte; the new long-lived broker/controller lives in the platform worker package. No per-agent Git checkout or rebuild is created. The executable runtime is under `/opt/agentonic/runtime/artifacts/<runtime-sha256>/`. The staging broker is under `/opt/agentonic/staging/releases/<broker-sha256>/broker.mjs`. Per-agent generated files are under `/opt/agentonic/instances/<workspace-id>/<agent-id>/azure_staging/releases/<deployment-id>/{manifest.json,runtime,prompts/,skills/}`; `runtime` references the exact shared artifact, and `current` selects the observed deployment. The literal `azure_staging` directory distinguishes this bounded slice from future production. `/etc/agentonic/staging/{manager.env,broker.env,agents/<deployment-id>.env}` holds root-only role/provider configuration. Services are `agentonic-deployer-staging.service` and `agentonic-staging@<deployment-id>.service`. The evaluator's existing directories, role, service and attestation are independent and unchanged. Local equivalents are in ignored `.local/staging/`, with the runtime artifacts remaining in `.local/runtime/`.

**Operations.** `pnpm setup:staging` provisions only the four restricted nonproduction deployer/runtime roles. Apply migrations, then run `node scripts/install-staging.mjs --local --start --runtime-sha256=<existing-frozen-hash>` and the corresponding `--azure` command. `pnpm dev:staging` starts an installed local controller in the foreground; do not start a second controller if its recorded process is already live. Installation measures the exact broker/runtime hashes and preserves all prior provider commitments. Web apps and ingestion are not deployed to the VM by this operation. `node scripts/check-review-flow-live.mjs --live --staging` uses an isolated synthetic workspace to verify real evaluation/approval, local and VM activation, cited private chat, systemd restart, revocation/content cleanup and retained usage. The content-free receipt is `.local/staging/live-report.json`; interrupted fixtures use the same command with `--cleanup --staging`. Never use a customer agent as a smoke-test fixture or fabricate its new consent.


**Verification checkpoint:** both measured hosts completed actual synthetic activation and cited private chat using the original frozen runtime. Each successful chat used 217 micro-USD, including retrieval. The VM service restarted and produced a fresh heartbeat while preserving the conversation. Stopping both deployments denied access and scrubbed conversation content; their usage and the earlier failed attempt remained recorded. The synthetic document was purged and workspace retired. The live check exposed and corrected ledger-column ambiguity and cleanup of stopped deployments; protocol-1 history is capped at nine completed turns. Staff and customer browser checks verified the expired approval, renewal dialog and Chats empty state. The real Corby SAT version remains historically approved and expired until its customer authorizes renewal; no customer consent was fabricated.

Final checks: 289 tests pass across 24 files. Prisma generation/validation, typecheck, lint, diff whitespace checks and all 15 reviewed skeleton baselines pass. No Next.js production build was run. Both staging controllers remain online; the existing evaluator remains active and its installation unchanged.

## 37. Whole-platform release and first connector implementation plan — 2026-09-18

**Purpose and scope.** Consolidate §§14, 19, 20 and 30–36 into an executable plan for the next release. Documentation of a task does not mean it is implemented. This plan introduces a bounded connector/tool exercise before completing production infrastructure, so the deployable product proves external account access and controlled actions as well as knowledge chat. The recommended first provider is **Google Drive**; the owner has raised Drive or Gmail as possibilities, but has not selected a provider, supplied an OAuth app or authorized external test writes. Resolve those dependencies before live integration work; contracts, fixtures and release preparation can proceed independently.

### 37.1 Starting point and release boundaries

- Implemented: separate Admin/Customer Next.js apps; verified identities and scoped database functions; prompt and non-executable skill authoring; private uploads and ingestion; frozen candidates; automatic evaluation/review; private local/Azure staging activation; bounded chat and provider accounting. The first owner-operated Azure activation/chat was audited on 2026-09-17; this is functional evidence, not a load benchmark or production acceptance.
- Still local: web apps and the platform ingestion/preview worker need hosted packaging and installation. The evaluator and staging controller/runtime already have Azure installation paths. Inventory the actual running services again before moving workers; do not start competing consumers or replace active runtime artifacts incidentally.
- Missing external execution: `packages/contracts/src/authoring.ts` requires an empty tool list; the frozen protocol-1 runtime has no general external-tool loop. Skills are instructions, not executable integrations. Existing database policy also restricts staging sources to uploads and deployments to no tools. A connector is not enabled by adding a UI button or relaxing those checks in place.
- Current RAG: Voyage embeddings, permission-filtered cosine search and full-text search, reciprocal rank fusion, then up to eight passages. The staging SQL takes up to 40 candidates from each search before fusion. There is **no second-stage model reranker**. See §30 and `packages/database/prisma/migrations/202609160025_staging_runtime_contract/migration.sql`.
- **Hosted beta:** the enabled product works through two HTTPS domains with the developer Mac off, using nonproduction data and explicit test consent. Existing expiry/budget boundaries remain visible; beta hosting does not imply production agent activation.
- **Production pilot:** separate production configuration/data/credentials, implemented ongoing operating authorization, period budgets, recovery, onboarding and acceptance for the enabled capabilities. It is not achieved by extending staging expiry dates or removing the staging environment check.
- **Capacity milestone:** 500 configured agents and 500 simultaneously active conversations are different workloads. Neither is established by the first deployment. Define and measure both inventory size and concurrency before promising capacity.

### 37.2 Order, dependencies and progress tracking

All milestones below are **planned**, not complete. Replace the status and attach evidence as each is delivered. Preserve unresolved blockers explicitly; do not mark a milestone complete solely because its code compiles.

| ID | Deliverable | Depends on | Completion evidence |
|---|---|---|---|
| P0 | Current-service continuity and diagnostic baseline | Existing staging installation | Re-verification and expiry/recovery tests; content-free operational diagnostics |
| P1 | Connection and tool authority contracts | P0; first provider selection before provider-specific live work | Reviewed schema/API/runtime contract, provider scope decision, two-workspace negative tests |
| P2 | First connection, selected-source ingestion and live read tools | P1; OAuth app/test account | Real scoped read, refresh/revoke/reconnect, citations and isolation demonstrated |
| P3 | One bounded write tool with user confirmation | P2 | Exact-action confirmation, visible external result, duplicate/crash/revocation tests |
| Q1 | Retrieval quality baseline and reranker decision | Existing upload pipeline; include P2 documents when available | Versioned synthetic benchmark and explicit adopt/defer decision |
| P4 | Reproducible whole-platform release and hosted beta | P0–P3 for connector-enabled beta; Q1 report; domain/environment setup | Clean install, all services hosted, Mac-off round trip, upgrade/recovery evidence |
| P5 | Production lifecycle, onboarding and pilot acceptance | P4; production setup and pilot scope | Applicable §14 gates pass; backup restore and production operating policies verified |
| P6 | Multi-host and 500-agent capacity milestone | P5 and measured workload | Reproducible load/failure report at agreed inventory/concurrency, with latency/cost limits |

Release packaging, DNS/SMTP preparation and Q1 can progress alongside P1–P3. If provider setup is blocked, ship a clearly scoped knowledge-chat hosted beta through P4's applicable gates; keep connector/tool controls unavailable and P2/P3 incomplete. This does not waive their gates for a connector-enabled pilot. Do not postpone a near-term host-expiry fix while waiting for OAuth credentials, or require the complete 500-agent infrastructure before testing a first connector.

### 37.3 P0 — service continuity and useful diagnostics

Implementation areas: `scripts/install-staging.mjs`, `apps/worker/src/staging-main.ts`, new forward database migrations, shared lifecycle contracts/UI, and the evaluator's separate registration tooling.

- [x] Implement a dedicated re-verification operation for the **existing** broker/runtime bytes. Verify installed manifests, file hashes, service identity and protected configuration permissions before advancing host verification. Do not rebuild an approved runtime, reset usage, revive a revoked host implicitly, or merely update the timestamp. Treat evaluator registration separately from deployment-host verification. Implemented 2026-10-05 as `pnpm staging:reverify`; see §39.7.
- [x] Expose host verification expiry, customer operating-consent expiry and activation-approval expiry as distinct facts in Admin; show customer-actionable availability without infrastructure jargon. Add an alert destination and tested advance-expiry alerts. Define who maintains verification and how failures are escalated; automated renewal must actually verify the installation. Progress 2026-10-05: verified automatic renewal and advance-expiry alerts (GitHub issue assigned to the owner) are implemented in §39.7; the Admin expiry view and the customer availability wording are implemented in §42.
- [ ] Cover renewal before expiry and recovery after expiry, including controller authorization failure, service restart limits and stale deployment records. Avoid implying that a powered-on VM is an authorized runtime. Verify no accidental paid-work replay or consent extension.
- [ ] Record completed/failed timestamps, queue delay, execution duration, error category and deployment/job correlation without storing message bodies or secrets in logs. Distinguish process liveness, dependency readiness and authorization.
- [x] Establish an initial database connection budget across both apps, ingestion/evaluation workers, controllers and brokers. Evaluate transaction pooling under the current role/context rules before changing endpoints. Reduce idle polling and repeated filesystem reconciliation while preserving timely revocation checks. *(§43: about 18 connections whatever the number of agents, 19 since §45; transaction pooling is not needed for this budget.)*

**Gate:** synthetic expiry/restart/renewal tests pass; the owner can see what will expire and who must act; unchanged frozen releases remain runnable without a rebuild. Apply live maintenance deliberately after preparing and reviewing the exact operation; this planning task itself makes no live changes.

### 37.4 P1 — define a minimal connection and tool contract

Implementation areas: `packages/contracts`, `packages/server`, reviewed Prisma migrations aligned with `docs/schema.dbml`, `apps/worker`, shared UI and the sibling runtime repository. Inspect applicable repository instructions before editing runtime code.

- [ ] Define three separate records/permissions: **connection** (authorized external account), **source** (selected content allowed into knowledge), and **tool** (specific operation an agent may request). Connecting an account grants neither unrestricted ingestion nor unrestricted actions.
- [ ] Map the target `connections`, `agent_connection_grants`, `configuration_tools`, `tool_invocations` and `tool_approvals` concepts onto the implemented schema. Add only the required slice through new migrations; do not assume target DBML tables already exist. Preserve tenant-inclusive references, actual initiators and deny-by-default grants.
- [ ] Specify OAuth start/callback state binding, account identity, refresh/reconnect, revocation, token encryption/secret brokerage and environment separation. Tokens stay out of browser payloads, model input, generated assets, logs and Git. Google sign-in and permission to access Drive/Gmail are separate flows.
- [ ] Define each tool's argument/result schema, resource/account bounds, side-effect classification, limits, timeout and error semantics. Validate permissions in the broker immediately before execution and before returning content. Model-generated IDs or URLs cannot enlarge approved scope.
- [ ] Version the requested-access snapshot and runtime protocol. Pin reviewed tool code and allowed operations in the frozen candidate; evaluate/reapprove scope changes. Publish a new code artifact without changing the currently running protocol-1 release. Keep old no-tool agents supported.
- [ ] Add bounded tool execution and explicit continuation/checkpoint state sufficient to resume after a confirmation or crash. Limit tool count, duration and cost. Tool results and connected documents are untrusted content, not authority to invoke more tools.
- [ ] Extend Customer authoring/connection selection and Admin review receipts together. Show the selected account, resources and operations without exposing tokens or private transcripts. Update skeletons after visual review.

**Gate:** deterministic tests cover wrong workspace/account/resource, revoked connection, removed actor, changed arguments, expired approval, unauthorized tool and prompt-injected action requests. A tool declaration alone cannot execute an action. Provider test setup is recorded before live calls.

### 37.5 P2 — first connection and read capabilities

**Owner update, 2026-09-18:** Gmail is the selected first connection: read/search mail, manage drafts and confirm sends. The replacement scope, acceptance matrix, staging secret-storage decision and rollout checklist are in [Gmail implementation](gmail-connection.md). Drive ingestion is deferred. The checkboxes below retain the original broader plan; they are not a completion claim for Gmail.

**Original recommendation: Google Drive, selected files, with a dedicated synthetic test account.** This tests both knowledge ingestion and live tools without starting with unrestricted mailbox access. Confirm this provider choice with the owner when beginning integration. If Gmail is chosen instead, document a replacement scope and acceptance matrix before implementation; do not quietly broaden this Drive slice.

- [ ] Register the OAuth application and exact callback URLs; configure designated test users and the smallest viable provider scopes. Account for provider verification and test-mode token lifetime separately from Agentonic's host/consent expiry.
- [ ] Prototype `drive.file` plus explicit file selection. Verify access to the chosen existing files, supported exports and the intended output location in the actual test account. Do not assume selecting a folder grants recursive access to all existing descendants. Do not fall back silently to whole-Drive access when a capability is unavailable.
- [ ] Support an explicit small set of readable formats, starting with the existing text/PDF parser paths and a deliberate text export for Google Docs. Represent unsupported formats honestly; Sheets/Slides parsing is a separate extension.
- [ ] Add selected-source ingestion with stable external identity, source provenance, version/change detection, bounded refresh and removal. Deny access promptly when the account/source is revoked; purge derivatives according to retention. Start with private or deliberately uniformly shared sources; mixed source ACLs remain disabled until their enforcement is implemented.
- [ ] Add a live read tool for authorized file content/metadata and a bounded list/search of already authorized resources. This must access current provider state rather than pretend that cached RAG content is a live tool response.
- [ ] Update evaluation and deployment authorization to permit exactly this reviewed connector scope. Current upload-only/no-tool guards must be replaced by explicit scoped checks in new migrations, not removed globally. Provider read permissions and Agentonic read-only tool policy must remain distinct even if an OAuth scope can technically write.

**Gate:** connect → select → ingest → ask with citations → read current file works on synthetic data. Changed/deleted files, removed permissions, disconnect, token refresh failure, account mismatch and source prompt injection have verified behavior. Tests prove that account connection does not expose unrelated files or authorize writes.

Provider basis, checked 2026-09-18: Google documents `drive.file` as non-sensitive per-file access and recommends it with Picker; broad Drive read/manage scopes are restricted. Recheck the exact scopes and verification requirements at implementation time. [Drive scope documentation](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

### 37.6 P3 — one useful write tool, end to end

**Recommended operation:** create a new text report in an explicitly authorized test destination, with a preview and customer confirmation. Existing-file overwrite, delete, move and sharing changes remain outside this slice. A narrow write still requires real execution controls; a button that only simulates success does not complete the milestone.

- [ ] Render the exact proposed account, destination, filename and content for the authorized customer. Record a one-time approval bound to the immutable operation arguments, actor, agent, environment and expiry. Any change invalidates confirmation; ordinary version approval is not consent to every write.
- [ ] Persist the invocation before the provider call. Enforce deduplication and a single execution claim. Use provider-supported idempotency or explicit reconciliation; if an external outcome is unknown, do not blindly retry. Record enough protected external identity to resolve the outcome without logging document content.
- [ ] Recheck resource rights and live grants when the customer confirms and when execution occurs. Safely resume the agent after confirmation without repeating prior paid work or resetting budgets.
- [ ] Show completed, denied, failed and uncertain outcomes truthfully, with a link to the created file when available. Preserve content-free audit and usage after source/transcript deletion.
- [ ] Exercise double-clicks, duplicate requests, timeout after external success, process crash, approval expiry, wrong approver, destination/content changes and revocation between confirmation and execution. Live tests use only explicitly authorized test resources and writes.

**Gate:** a customer can ask the deployed test agent to produce a report from authorized knowledge, inspect the proposed write, approve it once, and observe exactly one external file. The same behavior is evaluated through the new frozen runtime/tool release and visible in both apps' appropriate views.

**Gmail follow-up:** live read/search and mailbox draft creation use scopes with broader verification requirements. Gmail `gmail.readonly`, `gmail.compose` and `gmail.modify` are restricted; `gmail.send` is sensitive. Draft creation is not equivalent to permission-free text generation and its provider scope can also permit sending. Keep application tool permissions narrower than OAuth scope. An eventual send must bind exact recipients, subject, body and attachments to confirmation; test recipients only until explicitly enabled. Gmail scope selection is a separate product decision, not an automatic consequence of implementing Drive. [Gmail scope documentation](https://developers.google.com/workspace/gmail/api/auth/scopes).

### 37.7 Q1 — retrieval benchmark and optional reranking

**Implementation update (2026-09-18):** shared opt-in re-ranking, exact-duplicate removal, forward migration 28 and the isolated synthetic benchmark are implemented. The user-authorized nonproduction rollout is complete: migration 28 is applied, the local knowledge/preview worker and local/Azure staging brokers have re-ranking enabled, and the new Azure evaluator is installed and registered. The frozen `agentonic-runtime` artifact is unchanged. See [the execution guide and measured decision](rag-benchmark.md) and [content-free installation receipt](benchmarks/rag-rollout-2026-09-18.json).

- [x] Establish a versioned synthetic dataset with expected passages, paraphrases, multilingual questions, similar/conflicting documents, unanswerable queries and access-denied cases. Include a held-out set so tuning is not judged on its own examples.
- [x] Measure recall/hit rate at eight, ranking quality, citation correctness, abstention, unsupported answers, latency and provider cost on the synthetic corpus (citation/answer checks are labeled proxies). Record the corpus, chunking, embedding, fusion and runtime versions; distinguish retrieval quality from model response quality.
- [x] Compare current fusion with a second-stage reranker only after capturing the baseline. The initial pure-ranking comparison regressed; the coverage-preserving v2 follow-up passed and is recommended for controlled nonproduction rollout. If adopted, retrieve a larger authorized candidate set, rerank within explicit latency/cost limits, then choose the context passages. Add reservations/metering, timeout/failure behavior and permission rechecks; never send unauthorized candidates to a ranking provider.
- [x] Keep knowledge preview, evaluations and deployed chat consistent in the shared implementation and rollout configuration. Record a measured adopt/defer decision; reranking is not a prerequisite for the first connector merely because it exists as a technique.

- [x] Validate a coverage-preserving improvement on a fresh synthetic held-out set: v2 preserves baseline evidence, passes the original comparison regression and keeps held-out recall/expected-fact completeness at 100%.
- [x] Install and verify the v2 worker artifacts consistently in a controlled nonproduction rollout. Live synthetic checks passed for preview, six Azure evaluation cases, automatic approval, local/Azure activation and cited chat, VM service restart, revocation, content cleanup and retained usage. Each answer path proved actual settled reranker usage.
- [ ] Re-evaluate the original customer agent and obtain fresh operating consent before its next activation; its old deployment was stopped at the user's request for this rollout. Domain-representative evaluation remains required before broad production enablement.

**Measured Q1 decision (2026-09-18):** adopt the coverage-preserving v2 strategy for controlled nonproduction rollout. Every distinct passage in the original hybrid top eight is protected; re-ranking changes their order and fills only duplicate slots. The 52-document follow-up has two regression, six development and eight fresh held-out questions. All coverage, recall, answer-completeness and access gates passed; held-out duplicates dropped from two to zero, with median latency +0.835 s and average added cost $0.00006025/question. The subsequent authorized installation and synthetic activation checks passed on the actual workers; this remains nonproduction evidence, not a capacity or customer-domain quality claim. See [the reports, limitations and rollout guide](rag-benchmark.md).

**Gate:** an evidence-backed retrieval quality report and known limitations. Do not treat the existing seven-case agent evaluation or a successful chat as a representative retrieval benchmark.

### 37.8 P4 — reproducible release and complete hosted beta

Implementation areas: new release/package/install scripts, `.github/workflows`, app startup/configuration, worker entry points, deployment manifests and operations documentation. Keep systemd/fixed releases; no container platform is required by this milestone.

- [ ] Inventory every required process and configuration: Admin, Customer, ingestion/purge/preview worker, evaluator, controller and agent services. Record ports, restricted roles, secret ownership, dependency/readiness checks, persistent paths and compatible schema/runtime versions.
- [ ] Build immutable artifacts from known platform/runtime revisions with a lockfile, checksums and release manifest. The existing verification workflow does not yet produce a complete deployable platform artifact. Add packaging with only the required runtime dependencies and generated Prisma client.
- [ ] Run the repository checks before packaging. Full Next.js builds require the owner's explicit build authorization and an isolated checkout/CI release job; never build over the active development `.next` directories.
- [ ] Provide a repeatable fresh-install and upgrade command with preflight checks, migration order, health gates, controlled release switching and compatible application rollback. Database migrations are not automatically reversed with application rollback; document restore/forward-fix paths for incompatible changes.
- [ ] Configure chosen Customer/Admin hostnames, TLS reverse proxy, private app listeners, host-only sessions and callback URLs. Test origin validation, authenticated no-store responses, uploads and future streaming through the proxy. Apps coordinate through scoped database state; no direct Admin-to-Customer API or public per-agent port is required.
- [ ] Host ingestion/preview work as well as both web apps; preserve existing evaluation/runtime installation boundaries. Isolate any nonproduction and future production service identities, credentials and queues even when they share hardware.
- [ ] Exercise a hosted synthetic round trip with local services stopped: upload → processing → candidate → review/evaluation → approval → activation → chat, plus P2/P3 where enabled. Test restart and version replacement without silently selecting an unapproved candidate.

**Gate:** a clean host can install the documented release; the enabled workflow runs with the Mac off; failed rollout preserves a usable prior compatible release or reports a recoverable failure. Record the exact artifacts and completed checks. Public DNS setup alone does not satisfy this gate.

### 37.9 P5 — production lifecycle, access and operational acceptance

- [ ] Provision a separate production Supabase project/configuration, restricted roles, Storage policies and environment-specific provider credentials. Apply reviewed migrations through the existing migration authority. Do not copy test content or reset ledger commitments.
- [ ] Implement the production deployment/environment slice and ongoing customer operating authorization explicitly. Decide renewal, revocation and expiry policy; do not reuse staging consent as indefinite authorization. Preserve exact approval/code/config/tool/account binding for activation and replacement.
- [ ] Implement workspace/agent/run budget periods, reservations, usage reporting and unknown-outcome reconciliation. Migrate or reference existing provider facts by stable identity without double counting or resetting spend. Production ceilings are owner decisions, not inherited development allowances.
- [ ] Complete invitation acceptance, password recovery, SMTP, environment-correct auth redirects and staff account protection/MFA policy. Test expired sessions, removed members, staff/customer separation and unauthorized transcript access through actual domains. An invite-only beta may precede self-service signup.
- [ ] Define the enabled audience and conversation-sharing model. The staging owner-only transcript policy must not be broadened merely because another member can configure an agent. Implement only the checkpoint/memory scope required by enabled tool continuation or product promises; no claim of durable memory from transcript history alone.
- [ ] Set finite retention for conversations, indexed sources, action proposals, logs, backups and provider-held data. Implement offboarding/revocation/purge for the first connector and tool outputs where authorized, and document provider/backup deletion limits.
- [ ] Configure tested alerts for expiry, failed services, queue backlog, provider errors, budget exhaustion, disk pressure and database saturation. Restrict logs and establish an operational owner/runbook.
- [ ] Back up and restore database state, Storage objects, fixed artifacts and required configuration independently. Perform a replacement-host drill, including fresh credential delivery, correct deployment reconciliation and replay of deletions before serving restored content.
- [ ] Run applicable §14 tests with multiple workspaces and users, including installation failure, process loss during a tool action, uncertain external effects, active-version replacement and unauthorized rollback. Record unavailable features and their disabled entry points explicitly.

**Gate:** all enabled production features have evidence, operating ownership and recovery procedures; approved pilot users/data, budget and retention are recorded. General Gmail access, unattended writes, channels, schedules and cross-agent cooperation remain separate milestones under §19 and require their own acceptance before enablement.

### 37.10 P6 — capacity and multiple hosts

- [ ] Replace the current one-host-per-environment registration constraint with explicit multiple-host identity, placement, capacity, leases/fencing and safe replacement-host recovery. Do not widen a role to every deployment to make scheduling easier.
- [ ] Remove per-agent session-connection growth as the scaling model; benchmark a bounded pool/dispatch design under tenant isolation. Separate heartbeat frequency, queued work notification and cleanup cadence. *(Built in §43: one gateway per host, resting agents, separate report, claim and cleanup cadences. The benchmark remains.)*
- [ ] Make controller reconciliation incremental; avoid scanning all historical deployments, launching per-service checks and rewriting unchanged pointers every cycle. Review workspace-wide heartbeat locks, shared provider-budget contention and indexes for pending turns, host/deployment lookup and cleanup. *(Partly done in §43: two-second watches list only active deployments, one unit-state read per pass, the release pointer is set once, and conversations are indexed by deployment. Lock and budget contention remain to measure.)*
- [ ] Add bounded concurrency across an agent's independent conversations while preserving serialization within each conversation and one-time side effects. Measure retrieval plans and corpus size separately from agent count; tune filtered vector search without weakening access checks.
- [ ] Agree the workload: 500 configured agents, number simultaneously online, concurrent conversations/turns, corpus size, traffic bursts, acceptable queue/response percentiles, failure rate and spending ceiling. Test with synthetic data and mocked providers first; authorize any paid load separately.
- [ ] Publish load/soak/failure results, connection and memory peaks, queue fairness, cost and recovery observations. Scale VM/database/provider capacity from that evidence, with explicit headroom; one service's observed memory is not a capacity guarantee.

**Gate:** a reproducible report meets the agreed workload, isolation and recovery targets. A larger VM alone does not satisfy this milestone.

### 37.11 Execution rules and owner inputs

For each implementation slice, record: milestone ID/status; contracts and migrations changed; exact code/artifact versions; deterministic and live checks performed; operational changes; unresolved limits; and next dependency. Update this checklist and the relevant dated implementation section together. Keep the target schema and implemented migration scope clearly distinguished.

Required owner inputs when their dependent work begins: first connector/provider and intended operation; Google Cloud OAuth app ownership and a dedicated test account/resource selection; explicit permission for test writes; two app hostnames and DNS control; SMTP sender/service; production project/provider access; pilot users/data; budget, retention/recovery expectations and alert recipient. Do not request secrets in chat. Missing live-provider inputs need not block synthetic contracts/tests or packaging work.

Verification follows AGENTS.md: Prisma generation/validation for schema changes, typecheck, lint, relevant deterministic/full regression tests and reviewed skeleton checks for UI changes. Live acceptance uses separate synthetic fixtures and existing authorized budgets. Do not alter applied migrations, use real customer content as fixtures, broaden access as a shortcut, or change live Corby/VM services incidentally. Documentation-only changes need document/diff/link review rather than application builds or paid live tests.

## 38. Gmail first connection — staging implementation, 2026-09-18

[Gmail implementation and acceptance plan](gmail-connection.md) replaces the Drive-first slice at the owner’s request. It specifies owner-only staging connections, frozen operation selection, live read tools and durable per-action confirmation for mailbox writes. Migration 29 is applied to nonproduction; the Gmail-capable runtime, broker and evaluator are installed and registered for the local/VM test environments. The linked rollout checkpoint records artifact hashes and verification evidence. The shared UI follows §21. The owner completed Google account consent and confirmed live Gmail reads in private preview after the citation fix. Live draft/send acceptance remains pending; no Gmail-enabled agent was activated automatically.

### 38.1 Owner-authorized private preview tools — 2026-09-18

Owner request supersedes the initial preview restriction: private customer previews may use connected Gmail tools before review/activation. Migration 30 adds a preview-specific leased worker authority and explicit session policy, without granting staff or automated evaluations mailbox access. A start checkbox authorizes the prepared version’s tools for that private session; writes retain individual confirmation. See [Gmail implementation](gmail-connection.md#owner-authorized-preview-tools--migration-30) for policy, expiry, cleanup and rollout evidence.

## 39. Public web capability — Browserbase, 2026-09-18

Owner selected public website search and reading. **Acceso web** belongs in **Herramientas**, independently of customer-authorized **Conexiones**. Browserbase uses a protected platform key. [Implementation and rollout](web-access.md) specifies frozen grants, opt-in previews, staging authorization, public-only Search/Fetch, source links and conservative provider usage reservations. Website logins, interactions and background KB ingestion are outside this slice. Migration 31 extends the existing grant/ledger boundaries; immutable runtime releases must explicitly declare `webContract: "1"`. See that document for verified rollout evidence and remaining gates.

### 39.1 Bounded research and recoverable reads — 2026-09-18

Migration 32 preserves immutable registry limits while newly published runtimes opt into eight research calls with `webResearch: "1"`. Shared broker policy retains mandatory criteria, rejects unsupported matches and background-work promises. Recoverable read errors can lead to another source; live authorization and spending remain hard boundaries. Content-free failure diagnostics and a metered synthetic-model benchmark cover constrained comparison, failed reads and follow-up context. See [web research acceptance](web-access.md#research-quality-and-recovery--migration-32) for execution, evidence and limits.

### 39.2 Versioned VM staging release — 2026-09-18

Platform 0.11.0 and runtime 0.3.0 are published on `codex/public-web-research` and `codex/web-research-runtime`. The current evaluator, staging broker/controller and frozen runtime are installed and hash-verified on `vm-agents-01`; local staging is aligned. [Release hashes, verification deadlines and live evidence](web-access.md#vm-release-checkpoint--18-september-2026) record six passed evaluation checks, reranking, cited chat, public search/read, VM restart recovery, metering and fixture cleanup. Tool-bearing versions still require the existing staff approval gate. Customer deployments require explicit preparation, approval and operating consent/activation; the release does not automatically activate an existing version. Hosted web apps and production rollout remain in §37.

### 39.3 Preview-only model comparison — 19 September 2026

Customer preview chat now offers explicit per-message GPT-4.1 mini / GPT-6 Astra selection with a shadcn radio menu. Migrations 33–34 bind the selected model to the queued turn, provider metering and stored answer. They also allow an explicitly chosen US$3 preview ceiling and compatible frontier request reservations; existing/default previews remain US$0.25 and no accumulated usage is reset. This experimental broker override does not modify frozen candidates, approved evaluations, live Chats or VM deployments. See [preview model selection](preview-models.md) for contracts, accounting, operation and comparison procedures.

**Preview workflow update (owner direction, 2026-09-19):** customer previews use the latest prepared candidate without a historical version selector. Opening or starting a preview enables the candidate’s configured tools by default; this supersedes the earlier preview-checkbox opt-in UX in §§38.1–39. The frozen permission scope, live authorization checks and individual Gmail write confirmations remain enforced. Existing session policies and usage are retained. The preview UI keeps the spending ceiling and session controls concise.


### 39.4 Single submission and evaluation preparation — 19 September 2026

Owner-approved customer flow supersedes the separate initial submission/preparation steps in §35. The **Enviar a revisión** dialog collects the total preparation/execution/grading ceiling (US$0.05–1, default US$0.25) and explicit seven-day team-review/AI-knowledge authorization. The customer server invokes the existing submission and preparation commands in one verified-identity transaction. Submission acquires the workspace write lock; current agent/candidate/draft validation and preparation happen before commit. Any failure rolls back the submission, consent and queued preparation together. Duplicate submission attempts cannot queue another preparation. Success navigates to **Propuestas**; no provider calls run in the web request.

The table identifies **Versión N**, omits proposal/draft-revision numbering, and shows criteria preparation progress. **Revisar criterios** becomes available when criteria exist, before test execution; the existing per-situation decisions and final confirmation still gate execution. Once execution begins, **Ver resultados** opens the criteria, responses, findings and authorized budget/use without repeating the table’s version summary, status or comments. Empty/redacted reviews stay disabled. **Preparar evaluación** is an explicit recovery action only for existing unprepared submissions or attempts with status `error` or `cancelled`. It is unavailable during active preparation/evaluation and after completed results, including `needs_changes` and `needs_attention`. A completed nonpassing evaluation directs the customer to its results; correcting confirmed criteria would require a separately named, explicitly authorized new evaluation, not the preparation recovery action. Existing records are not automatically authorized or restarted, and accumulated usage/reservations remain intact.

No migrations, worker/runtime replacement, live AI invocation or customer submission is needed for this application-only change. Deterministic restricted-role database tests cover atomic queuing, rollback on preparation failure, stale revisions, missing consent/budget and duplicate attempts. UI action tests cover pending, ready, evaluating, redacted and recovery states. The existing five-column proposal skeleton remains structurally valid.


### 39.5 Model evaluations and repeatable review (19 September 2026)

This replaces the single-model/confirm-and-execute flow in §39.4. Submission authorizes **criteria preparation only**. Confirmation records the current criteria revision without starting inference. The customer then explicitly authorizes a model evaluation from the proposal menu: choose model/reasoning combinations and a run budget (USD 0.05–50). Every run repeats all included business situations and immutable platform controls for every selected combination. A model counts as 100% only when every selected level passes every situation. Model scores never average away a failing level.

The proposal table retains version/status/evaluation/comments and adds **Criterios** and **Resultados**. Pending criteria are the emphasized next action. Each column opens its own dialog. Results open at a model aggregate index, then drill into situations by level. Progress is persisted server-side, polled while running, and survives closing/reopening the dialog. The menu contains **Evaluar modelos**, disabled until criteria are confirmed and throughout an active run. It becomes available again after success, failure or interruption. The confirmation states that every run uses metered AI and may incur charges; no card integration or charge capture is represented as implemented.

Migration 35 adds immutable evaluation batches, per-run execution model/effort, and a mutable current criteria confirmation revision. Each batch captures the authorized criteria revision/hash, selected combinations, request identity and budget. The workspace/preparation locks serialize customer changes and provider reservations. Repeated request IDs return the original batch only for identical input; concurrent runs and criteria edits during active execution are blocked. Editing criteria clears confirmation and creates a revision; prior datasets, assessments, costs and unknown-outcome reservations remain unchanged. Each batch has a separate explicit ceiling, while preparation-level accumulated consumption remains retained. Cancellation revokes every associated execution. Existing single-model reviews remain readable as historical one-model runs; they are not automatically reevaluated.

Approval eligibility requires all requested model/level runs to pass with current evidence, the latest batch and matching confirmed criteria revision. Existing staff and tool-scope gates still apply; 100% situations is not itself deployment activation. Staff review and approval receipts use the same model aggregate results. Receipts retrieve the criteria revision that actually supported the approval, not subsequently edited criteria.

The shared catalog includes GPT-5.4 mini, GPT-5.4, GPT-6 Astra and historical GPT-4.1 mini. Supported API reasoning levels are validated in contracts and SQL. New exploratory previews default to GPT-5.4 mini/medium; legacy approvals and historical turns retain their actual mini model. Migration 36 pins model/effort per preview and deployed-chat turn, validates retry identity, and permits only combinations recorded in the deployment's approval. The trusted broker applies those parameters without modifying frozen runtime assets, records model-specific usage, and preserves tool authorization and conversation budgets. Configurable reasoning does not authorize additional tools. Switching preserves conversation history; the current evaluation suite tests situations independently and does **not** claim specific multi-turn model-switching coverage.

Evaluation protocol 3 workers execute this matrix. Criteria generation and semantic judging currently remain GPT-4.1 mini; the evaluator is identified in result detail. New batches use `grounded-review-v3`, which distinguishes unsupported policies from harmless elaboration, avoids demanding every limitation in general self-descriptions, and receives frozen requested permissions and the isolated read-only evaluation scope. These evaluations do not execute Gmail writes or public-web tools and do not certify their operation. The exact worker hash, model identifier, effort, dataset, rubric and runtime are bound into evidence; model aliases are not claimed to pin upstream weights.

Verification uses synthetic database fixtures and mocked provider calls; no paid evaluation of customer content is necessary to verify workflow transitions. Worker upgrades remain explicit, idle-queue, measured installations. Provider budgets and real customer criteria/results are never reset as part of deployment.

### 39.6 Compact customer proposals (20 September 2026)

Owner-approved presentation supersedes the proposal-table columns in §39.5. The customer table has an action menu and four data columns: **Propuesta**, **Estado**, **Criterios**, **Resultados**. Estado displays one badge without secondary text: **En proceso**, **Aprobada**, **Requiere cambios**, **Requiere atención**, or **Cerrada**. These are derived presentation states; stored submission decisions, review states and authorization rules are unchanged. Rejected, withdrawn and revoked proposals are closed. A historical approval appears as approved only when the server's lifecycle read confirms current validity; otherwise it needs attention. Explicit decisions take precedence over evaluation progress, while a new active run supersedes an earlier evaluation failure. Preparation/evaluation interruptions, cancelled review authorization, unavailable criteria and expired approval require attention.

Criteria show **Preparando…**, **Confirmar**, **Ver**, or **—**. Results show **—**, **Evaluar**, **Ver progreso**, or the existing count of models passing every selected level. Evaluar opens model selection and explicit budget/consent authorization; it never starts inference merely by opening the dialog. The menu retains repeat evaluation, criteria preparation/recovery, authorization cancellation and withdrawal. Clicking the proposal descriptor opens the frozen configuration receipt. Evaluación and Comentarios are removed from the table. The proposal loading skeleton matches the five total columns.

The Propuesta cell identifies **Versión N · Revisión R**, where R is the current criteria revision; unavailable numbers use an em dash. The Criterios cover and Resultados dialog use the entity name as their title, with no preheader. Their description shows the shared agent icon followed by the agent name and version/revision descriptor. The criteria cover uses its current saved revision, while results identify the frozen revision of the selected execution. This replaces the criteria cover’s agent/version grid. Resultados table cells remain on one line.

The proposal dialog leads with a compact receipt of the frozen configuration: saved system prompt, skill names, collection/tool/connection counts, and the included web/Gmail operations. Tools count the saved capability grants; connections count distinct saved connection IDs. Counts and content come from the authorized configuration-release snapshot, never the current draft or current connection inventory. Source manifests are omitted from the presentation contract; unavailable snapshots show an explicit empty state. The four configuration counts reuse the corresponding skills, collections, tools and connections icons. The dialog omits the status and comments section. The criteria cover uses **Editados** as its column heading. Situation fields place labels and textareas directly in the form, retaining distinct message/expected-response color cues without padded outer frames.

### 39.7 Registration re-verification and expiry alerts (5 October 2026)

Host and evaluator registrations still last seven days. `pnpm staging:reverify` renews them by re-measuring the existing installation, never by rebuilding, reinstalling or only advancing a timestamp. Without options it shows each registration's expiry read-only; `--verify` runs every check without changing anything; `--renew` re-verifies and renews registrations that expire within two days (`--now` regardless; `--only=<target>` limits targets). Checks are defined once in `scripts/staging-registrations/policy.ts` and generate the root script run over SSH, so gathering and judging cannot drift.

- **Azure deployment host:** host identity, pinned Node, broker and frozen-runtime file hashes, root-owned read-only releases, controller and agent-template unit bytes (generated by the installer's shared `scripts/staging-units.mjs`), loaded unit state without drop-ins, private configuration pinned to the broker hash, controller and running agent services executing the verified program, and no listening Node process. Renewal advances `verified_at` only for the unrevoked row with unchanged hashes, then requires a fresh controller heartbeat.
- **Azure evaluator:** the same artifact and Node checks, the unit hash recorded at installation, private `worker.env` pinned to the worker hash, the dedicated no-login account unable to modify its program or read its secrets, and a restart that yields a new active process running the verified program. Registrations stay immutable: renewal ends the old row (retires it since §41; it was revoked before) and inserts a new one carrying the installation attestation plus a `reverification` record of what was checked.
- **Local registrations:** program, runtime and private-profile checks on the Mac. They renew while valid but are never revived automatically once expired; name them with `--only` to recover them.
- **Refusals:** missing, revoked or retired registrations are not recreated. Evaluator renewal is deferred while Azure evaluation work is queued or running. (Until §41 it was also deferred while a passed evaluation awaited a review decision, because revocation invalidated that evidence; retirement keeps it valid, so that deferral and `--allow-pending-approval` are gone.) Usage, consent and approvals are untouched.

**Schedule and alerts.** `pnpm staging:reverify --schedule` installs a per-user launchd job on the owner's Mac (09:00 and 21:00 local; runs on wake if missed) executing `--renew --publish`; `--unschedule` removes it. The Mac is the renewal point because it holds the SSH key and owner database credential; the VM never certifies itself. `--publish` writes a content-free report (registration names, expiry, outcome, failed check names, assignee login) to the `STAGING_REGISTRATIONS` repository variable and dispatches `.github/workflows/staging-registrations.yml`. That workflow also runs every six hours, holds no database or VM credential, and opens one issue assigned to the owner (as the workflow bot, so the owner is notified) when an Azure registration failed verification, is missing, expires within 24 hours, or when the Mac has not reported for 36 hours. It comments when problems change, reminds daily while unresolved, and closes the issue once everything is valid. Local registrations are reported but never alert.

**Verification checkpoint:** 14 deterministic policy tests cover renewal windows, revoked/missing/local-expiry rules, each check's failure, fail-closed missing facts, unsafe-input refusal and alert timing. Read-only verification passed for all four installations, a deliberately loosened local file permission was detected, and the alert workflow script was dry-run against the repository. The first live renewal on 5 October re-verified the Azure host (heartbeat resumed), restarted and re-registered the Azure evaluator with no unexpected restarts, renewed the local evaluator and left the expired local host untouched. The scheduled job ran under launchd and published its report. The workflow takes effect once merged to `main`.

## 40. Runtime engine boundary and side-by-side runtimes — 5 October 2026

**Decision (owner, 5 October 2026).** The frozen runtime artifact is the agent engine; the platform broker is the credential, provider and tool-execution boundary. The runtime source moves into this repository as `packages/runtime`. This resolves the audit finding that the agent loop ran in the broker: evaluation, preview and staging now run the same pinned bytes that approval binds, and a behavior change ships as a new runtime installed next to the old one instead of a host-wide broker replacement.

**Broker protocol 2** (`packages/contracts/src/runtime-protocol.ts`) applies to artifacts whose manifest declares `brokerProtocol: "2"`.

- **Runtime** (credential-free child process; lint rules forbid provider, database, connector, process and network imports): verifies the frozen candidate bytes, composes platform, customer and skill instructions, and owns the research policy text, the tool descriptions offered to the model, the bounded loop (eight research calls, 65-second research window, three mailbox calls, then a final-answer phase), the citation-constrained answer format and answer parsing.
- **Broker** (`apps/worker/src/broker.ts`): pins model, reasoning and output limits from the turn record; attaches argument schemas from the shared contracts; accepts only tools live-granted for the turn; executes only a function call the provider just returned, once; substitutes the provider's own call and reasoning items into the transcript, so reasoning content never reaches the child; reserves before every paid call; never replays a request with an unknown outcome (one final-answer request may follow an interrupted research request); enforces per-turn ceilings; records the fixed budget-stop and Gmail-proposal answers itself; validates citations, derives the knowledge-base evidence flag, appends source links only from reads it performed, and records the answer.
- Automated evaluation runs the same artifact with tools withheld. Protocol-1 artifacts (runtime 0.3.0 and earlier) keep their original broker path unchanged until no granted release declares protocol 1.

**Packaging and catalog.** `pnpm package:runtime` builds from a clean, committed checkout; bundle paths are relative to the repository root, so a commit produces the same bytes from any checkout. `pnpm setup:preview` registers releases whose source is `https://github.com/Avilabs-LLC/agentonic`, subdirectory `packages/runtime`, under the template `agentonic-assistant`. Repository identity is immutable, so the earlier `agentonic-base` template keeps the runtime-repository releases (0.3.0 and earlier). Every later release for configuration contract 0.1 publishes under one template version, because agents choose runtimes only within their own template version. No agents or deployments existed at this change. The `Avilabs-LLC/agentonic-runtime` repository is frozen as the source of record for releases up to 0.3.0.

**Side-by-side runtimes (migration 38).** `runtime_host_artifacts` (per host; retirement only, refused while a queued, preparing or running deployment uses the artifact) and `evaluation_worker_runtimes` (append-only per evaluator registration) replace the single runtime hash columns, with existing values backfilled. Eight functions are redefined with only the hash comparison changed to a list lookup. `pnpm runtime:install --azure|--local --runtime-sha256=<hash>` copies a catalogued artifact into `/opt/agentonic/runtime/artifacts/<hash>`, verifies its bytes on the VM and registers it for the host and the active evaluator; nothing restarts, because brokers and evaluators load artifacts by hash for each turn. `--retire` withdraws an artifact from the host. `install-staging` no longer treats a runtime change as a broker replacement. Re-verification (§39.7) checks every registered runtime and renews evaluators with the same list.

**Still single per host: the broker program** (built in §41). Replacing it still requires no active deployments; staging deployments end within seven days. Next step, designed but not built: one systemd template per broker release (`agentonic-staging-<release>@`), broker registrations per release, deployments recording the broker they were prepared with, superseded copies finishing their leased turn without claiming new ones, and evaluator registrations distinguishing *retired* (normal succession; evidence stays valid) from *revoked*. With behavior in runtimes, broker releases should be rare: security fixes, provider changes and new tool kinds. A shared broker serving many agents' runtimes (§37.10) builds on this boundary.

**Verification checkpoint.** 17 protocol tests cover the real loop against the real broker (passages, web research to its eight-call limit, research timeout without replay, budget stop, Gmail proposal, reasoning-item substitution), adversarial broker refusals (provider controls, ungranted tools, invented transcript items or calls, double execution, replay, call ceilings, answer invariants) and a packaged artifact run in a child process for staging and evaluation. A database test covers backfill, lookup, retirement refusal while in use, immutability and denial of direct application-role reads. Deliberately disabling single execution, the no-replay rule or the host lookup each fails a test. The full suite (461 tests), typecheck, lint, Prisma validation, skeleton and version checks pass.

**Rollout checkpoint (5 October 2026, after PR #19).** Order used: migration 38 applied to the nonproduction project before merging, because the scheduled re-verification job runs `main` and reads the new tables; the running VM services kept working against the redefined functions (controller heartbeat 2 s later). After merging, `pnpm setup:preview` registered `0.4.0-preview-0eb33696` (artifact `9f24d071`) under the new template. On Azure, the protocol-2 broker `042e0795` replaced the previous broker while no deployments existed; runtime 0.4.0 was installed next to 0.3.0 (`5e776a45`); the evaluator was redeployed as `ec3aa269` and re-registered. The Azure host and both evaluator registrations serve both runtimes. The installed bundle is byte-identical to the build the tests exercised. All four installations passed `pnpm staging:reverify --verify`, and the alert report was published. The local deployment host was left expired with its earlier broker; run `install-staging --local` before using local staging chats. No paid live turn has been run on protocol 2 yet.

## 41. Side-by-side brokers and services that report — 5 October 2026

**Why.** Two audit findings: replacing the broker program waited for every deployment to stop (§40's next step), and staging operations failed silently. On 5 October the deployment controller had restarted 51,877 times since its registration lapsed on 26 September, logging only `staging_installer_stopped`; the evaluator showed `active` while refusing all work; the VM's 07:32 UTC restart went unnoticed. That restart was requested by the Azure host (`hv_utils: Shutdown request received`), not by unattended upgrades: `Unattended-Upgrade::Automatic-Reboot` is off, so installed kernels wait for the next restart.

**Brokers side by side (migration 39).** `runtime_host_brokers` lists every broker release a host holds; `runtime_hosts.broker_sha256` is the current one (a deferred constraint keeps it registered and live). The controller runs the current broker; every new copy of a deployment starts on it. Each deployment records the broker its serving copy runs (`broker_sha256`) and at most one other copy: a successor starting on the current broker, or the replaced copy draining. Copies authenticate with per-copy secrets; `agentonic.deployment_copy()` resolves a secret to `serving`, `successor` or `draining` and refuses any copy whose broker is not live.

- **Move:** when the current broker changes, the controller moves running deployments one at a time per host (`deployment_host('move')`, enforced in SQL). The successor reuses the frozen manifest and assets, reports the broker it runs, and on `ready` swaps in atomically: it becomes the serving copy and the old one drains, finishing the turn it leased (its lease, tool and metering calls still work) but claiming nothing new and never becoming ready again. The controller stops a draining copy when it exits or after 150 s (turns end within two minutes) and confirms `drained`. A successor not ready within 120 s is abandoned; the serving copy keeps serving and the move is retried after ten minutes. Each move is audited as `deployment.broker_moved`.
- **Restore:** a serving copy that can no longer run (its broker was revoked, or its installation or secret is gone, e.g. a rebuilt VM) is replaced on the current broker at once from the same frozen manifest, audited as `deployment.restored`.
- **Lifecycle:** a broker that no live copy runs retires on the controller's next poll; reinstalling a retired release brings it back. Revocation is the emergency path: its copies are refused immediately and restored on the current broker; it is irreversible, and the current broker can be neither retired nor revoked. Stopping or superseding a deployment clears every extra copy.
- **Machine:** one systemd template per broker release, `agentonic-staging-<broker>@<deployment>.service`, with copy configuration under `/etc/agentonic/staging/agents/<broker>/`. `install-staging` installs a new broker next to running copies without waiting; only the first installation over the old shared template still requires no active deployments. It removes templates of retired brokers.

**Evaluators: retired versus revoked.** Normal succession (renewal, `register-evaluation --replace`) retires a registration: it takes no more work, but evidence it produced while active stays approvable. `--revoke` withdraws trust from everything it produced. Renewal therefore no longer waits for pending approvals.

**Wait and report.** The controller, agent copies and evaluator no longer exit on a refused registration or a database outage. They retry with backoff (refusals up to every 30 s so renewal takes effect quickly; outages up to every 60 s) and write one JSON line per change of state: `service_started`, `service_waiting` (with `reason`, `since`, `attempts`), `service_recovered`, `service_stopped`, and per deployment `deployment_waiting`/`deployment_recovered` with the failed step. Reasons are categories (`registration_refused`, `database_unreachable`, `database_busy`, `runtime_mismatch`, `copy_exited`, ...), never message text or content. A copy exits 0 when it drains or its deployment ends, so systemd does not restart it. Only configuration and integrity problems exit non-zero, and start limits make them visible failed units: five starts in ten minutes for the controller and evaluator, three in two minutes for a copy, after which the controller paces further attempts (10 s to 5 min).

**Health in the re-verification report.** Every `pnpm staging:reverify` run now reads, over one SSH session, each Azure service's state, restart count and last state line from the journal, plus failed agent copies. A waiting, stopped or failed service raises the GitHub issue even while its registration is valid. So does an unreachable VM, or a Mac that no longer holds the bytes needed to rebuild the VM (every live broker, the evaluator program and every installed runtime). The issue also notes the VM's uptime and any updates waiting for a restart; these notes never alert by themselves.

**Packaging.** A bundle's bytes name its release. A rebuild that produces identical bytes from different sources (a comment change) is the same release: the first build's manifest stays its provenance, and the packager reports `sourcesChanged` instead of refusing the reinstall.

**Rebuilding `vm-agents-01`.** Everything on the VM is reproducible from the Mac and the database: provision a VM named `vm-agents-01` with SSH and sudo, then run `deploy-evaluation-staging --deploy` (Node, evaluator, first runtime), `register-evaluation`, `install-staging --azure --runtime-sha256=<hash>`, `runtime:install --azure` for each other runtime, and `staging:reverify --verify`. Running deployments restore themselves on the new host. Not covered, and owner decisions: a second host, a timed drill on a fresh VM, and database backups (the Supabase Free plan has none). VM backups are below.

**Restart window (owner decision, 5 October 2026).** Updates install themselves daily, but kernel and library updates only take effect after a restart, which until now came unannounced from Azure. `pnpm staging:restart-window` installs `agentonic-restart-window.timer`. It restarts `vm-agents-01` on Sundays at 04:00 Canary time (the owner's time zone; `OnCalendar` follows daylight saving), only when `/var/run/reboot-required` exists. A window missed while the VM was off is skipped rather than run late. Services come back on their own: the controller and evaluator are enabled units, and the controller restarts running agents' copies. A reply in progress at that moment is interrupted. The unit text lives in `scripts/staging-units.mjs`. The twice-daily check reports the window as a problem if it is missing, altered or inactive. When updates are waiting, it notes when the window will apply them. `--remove` uninstalls it.

**VM backups (owner decision, 5 October 2026).** Azure Backup protects `vm-agents-01`. The Recovery Services vault is `rsv-agents-spaincentral` in `rg-agents-prod` (Spain Central), with locally redundant storage. Soft delete is always on and keeps deleted backups for 14 days. Trusted Launch requires an Enhanced policy, so `agentonic-daily-14d` runs daily at 02:00 UTC, an hour before the Sunday restart window. It keeps daily recovery points for 14 days and quick-restore snapshots for 2 days. The expected cost is about US$6–8 a month, billed mostly on the roughly 7 GB of data actually used. A backup restores the whole VM: programs, configuration, private copy secrets and release directories. It does not cover the database. The rebuild procedure above remains the path when the VM itself is lost. The Mac is signed in to the Azure CLI as the owner, and no Azure credential is stored in the repository. Each twice-daily `staging:reverify` run reads the vault's backup item through that sign-in. It raises the alert when the last backup failed, is older than 36 hours, protection has stopped, or the sign-in has lapsed. The issue notes the time of the last backup.

**Verification checkpoint.** 474 tests pass. New tests cover: the reporter's categories, backoff and log lines; release recording; registration policy for broker releases, health findings and machine notes; and the SQL for move, drain, retirement, revocation, restore, abandon, stop and evaluator retirement versus revocation. One end-to-end test drives the real controller logic against the real database functions through a broker upgrade, a revocation, a copy that exits right away, an abandoned successor and a stop. Deliberately breaking the drain wait, the draining copy's claim refusal, the reported-broker check or the retired-evidence rule each fails a test. Typecheck, lint, Prisma validation, skeleton and version checks pass.

## 42. Admin expiry view — 5 October 2026

**Why.** Three deadlines govern whether an approved version can run, and each has a different owner (§36). The **activation deadline** (approval expiry) is the customer's: after it, a new authorization needs a renewed approval. **Operating consent** (a deployment's `authorized_until`, at most seven days) is also the customer's. **Server verification** (host and evaluator registrations, seven days) is the Agentonic team's, renewed by `staging:reverify` (§39.7). Until now Admin showed the first two only on a version's receipt, and staff could not see the third at all.

**Vencimientos (`/expirations`).** A staff page under Operación answers what expires, when, and who must act:

- *Servidores y evaluadores* lists each deployment host and the latest registration per evaluator role (the same choice `staging:reverify` makes), in plain language ("Agentes en la VM de pruebas"), with expiry, last verification and a state: `Vigente`, `Vence pronto` (within a day, when the twice-daily renewal should already have run), `Vencida`, `Revocada` or `Retirada`.
- The table lists approved versions with something still to expire: a valid approval not yet in use, or a pending or running deployment. Each date has its own column (*Plazo para activar*, *Uso autorizado hasta*, *Servidor verificado hasta*), and *Próximo paso* names who acts next and by when. Examples: the customer authorizes use, the team activates the version, the customer authorizes again before consent lapses, or the team renews server verification. A running agent outlives its activation deadline, so continuing past consent then needs a renewed approval. When the database reports a deployment as unauthorized for a reason it does not expose, the step is "Revisar el comprobante"; reasons are never guessed. Rows needing action now come first, then the nearest deadline. The ID opens the version's receipt.

**Data (migration 40).** `agentonic.runtime_registrations()` returns host and evaluator registrations to any active staff member, without workspace context, customer content or hashes. States come from `agentonic.registration_state()`, which applies the same seven-day rule the services are held to, so the page never shows a renewal that has not happened. `review_queue()` additionally returns the latest deployment's environment, authorization and consent expiry. Every workspace is still read in its own verified transaction, and a failed read fails the whole page rather than hiding a deadline. Customers and the service roles cannot call the new function.

**Verification checkpoint.** A database test replays every migration and checks the seven-day expiry, the expiring, expired and revoked states, the deployment losing authorization with its host, the renewed evaluator being reported over the retired one, and refusal for customer and worker roles. Unit tests cover row selection, each next step and ordering. The page, loading state, empty state, dark theme and phone width were reviewed with synthetic data before the skeleton baseline was recorded.

**Customer availability wording (5 October 2026).** Customers see the same facts without infrastructure terms. The agent header says "Disponible hasta el …", "No disponible por ahora", "Activación pendiente" or "Sin activar". Each activation on the Activación tab carries one sentence: until when it is available and what the customer should do next. That means authorizing use again before consent ends, renewing the approval first when it has lapsed, or nothing at all when the problem is on Agentonic's side: a silent service, or a server whose verification lapsed. The sentence comes from `customerAvailability()` in `packages/contracts/src/availability.ts`, built only from `lifecycle_state()` facts already returned to customers. No migration was needed. A reason the database does not report is never guessed; the sentence then says only that the authorization is no longer valid. Places are "Servidor de pruebas" and "Entorno de desarrollo" instead of VM and local. Chats explains an unavailable agent instead of silently disabling the input. Staff wording is unchanged. Tests check every state's sentence and that none contains an infrastructure term.

**Documentation.** `docs/current-state.md` is a short summary of what runs where, what works and what isn't built. The README and `AGENTS.md` point to it, and changes that alter what runs where update it.

## 43. Resting agents and the database gateway — 5 October 2026

**Why.** The audit's first capacity limit. Every activated agent kept a service running around the clock with its own pool of two session connections, asking the database for work every two seconds. On the Supabase Free plan (60 connections, 15 pooled per database role, 200 pooler clients) at most about seven agents could hold both connections, because all agent services share one role. At 250 agents that would have meant about 250 database calls a second with no customer activity, and about 21 GB of the VM's 32 GB for idle Node processes (85 MB each, measured). The beta needs at least 250 activated agents. The principle now: cost follows work, not activated agents.

**Resting agents (migration 41).** A serving copy with nothing to do rests: ten minutes after its last turn, or one minute if it never had one (a copy started for a move or an activation). It calls `deployment_service('rest')`, which records `deployments.resting_since`, and exits 0, so systemd leaves it stopped. A turn already waiting refuses the rest (`pending`). The controller lists `resting` and `pending` for each deployment. It starts nothing for a resting deployment until a turn waits for it; then `deployment_host('wake')` clears the mark, vouches for the copy for one heartbeat interval, and the copy starts. A copy that reports (`ready` or `heartbeat`) is awake however it was started.

- **Availability:** `agentonic.deployment_online()` replaces the copy-heartbeat checks in chats, the agent listing and lifecycle state. A deployment is online if its copy reported within 60 seconds, or if it rests on a host whose controller reported within 60 seconds with a valid registration and a live broker. If the controller stops reporting, its resting agents go offline, because nobody would start them.
- **Failure:** a woken copy that never reports goes offline after 60 seconds like any silent copy, and its restarts back off as before.
- **Upgrades:** a resting deployment moves to a new broker by starting the successor only. The successor swaps in awake, and the old copy, never started again, is removed.
- **Waiting turns** are what the serving copy would claim next. The conversation check already includes the deployment's own authority, so a waiting turn whose authority lapsed wakes nothing.

**Controller cadence.** A `watch` every two seconds updates the host's heartbeat, rechecks deployments still starting, and lists active deployments with `resting` and `pending`. A full `poll` every thirty seconds rechecks the authority of every active deployment, cleans up content, retires unused brokers and lists ended deployments, whose copies are then removed. Every copy call still enforces authority immediately. Unit states are read with one `systemctl list-units` per pass, not one call per deployment. The release pointer is set once per deployment per controller run. Running copies report every ten seconds and claim work every two. Conversations are indexed by deployment for claims, waiting-turn checks and cleanup.

**Database gateway.** One `agentonic-gateway-staging` service per host runs the current broker program with `--gateway`. It holds the runtime role's database connections (five by default) for every agent copy on the host.

- **Socket:** systemd owns `/run/agentonic-gateway/gateway.sock` (`root:agentonic-gateway`, mode 0660). Agent service templates add `SupplementaryGroups=agentonic-gateway`, so only copies and root can open it.
- **No password in copies:** copies started from this broker hold no database password. `broker.env`, which seeds every copy's configuration, carries the socket path; since §44 it carries no provider key either. `gateway.env` holds the runtime role.
- **Fixed calls:** a copy can send only four calls (`deployment_service`, `staging_worker`, `web_staging`, `gmail_staging`), always with its own deployment ID and secret. The gateway checks their shape (operation name, UUID, 64-character secret) and runs fixed statements. The database authorizes each call exactly as when copies connected directly. Replies carry database or network codes only, and nothing is logged per call.
- **Limits:** four calls in flight per copy, 256 waiting for a connection, and 4 MiB per request.
- **Restarts and outages:** systemd keeps the socket while the gateway restarts. Copies wait (`gateway_unreachable`) and reconnect. The gateway reports database outages as its own service state, so the twice-daily check sees them.
- **Older brokers:** copies of brokers from before the gateway keep connecting directly until they are moved. The template keeps the database CA they read.

**Connection budget.** Customer and admin apps use 3 connections per instance each, the knowledge worker 3 (4 since §45), the evaluator 2, the controller 2 and the gateway 5. That is 18 (now 19) with one instance of each app, whatever the number of activated agents. A resting agent uses no process, connection, memory or database call. An awake agent makes one claim every two seconds and one report every ten, through the gateway. Still open:

- the Supabase plan upgrade before outside testers (an owner decision; the Free plan has no backups and pauses inactive projects);
- transaction pooling, needed only once apps run several instances;
- the 250-agent synthetic load test (§37.10);
- push notification of new turns, replacing awake copies' claim polling.

**Re-verification.** The twice-daily check also verifies:

- the gateway's unit, socket unit and socket ownership;
- that `gateway.env` is private and pins the current broker;
- that `broker.env` carries no `DATABASE_URL`;
- that the gateway runs the current broker.

Its health report includes the gateway's state and last state line.

**Verification checkpoint.** All tests pass. New tests cover:

- in SQL: resting, waking, availability through the controller, offline without it, lapsed authority, `watch` versus `poll`, and moving a resting deployment;
- the controller against the real database functions: a resting copy is started only for a waiting turn;
- the controller with 250 resting agents: no starts, unit checks or per-agent calls per pass, and only the agent a turn waits for is woken;
- the gateway: allowed calls only, shape checks, codes without messages, per-copy limits, oversized requests, and reconnecting after a restart.

Deliberately breaking each of these fails a test:

- availability for resting agents;
- the waiting-turn refusal;
- the serving-only rest;
- the conversation authority check;
- the `watch` listing;
- waking;
- clearing the mark on report and on a move;
- the controller's resting and wake handling.

The packaged gateway was also run on the Mac against the nonproduction database. Calls crossed TLS and the pool, and the database refused an unknown deployment, as expected. It stopped cleanly. That run found two defects, both fixed. macOS silently shortens socket paths longer than 104 bytes, and the gateway now refuses them. A failure after the gateway started listening could leave the process alive.

## 44. Where secrets live — 5 October 2026

**Why.** The audit found secrets spread too widely. The Gmail token key and the Google client secret were in the customer app, the knowledge worker and every agent service. Every agent service also held the OpenAI, Voyage and Browserbase keys, and the worker held the Supabase secret key, which bypasses every Storage rule. Stored Gmail secrets did not say which key sealed them, so the key could not be replaced without a format change. The principle now: a secret lives only in the processes whose own calls need it, and every stored secret names its key.

**Key names and rotation.** Stored Gmail secrets (refresh tokens, proposed arguments, OAuth verifiers) and the OAuth cookie are sealed as `v2.<key name>.<iv>.<tag>.<ciphertext>`. The key name is the first 16 hex characters of a domain-separated SHA-256 of the key, so it identifies the key without revealing it. Associated data still binds each value to its record and purpose. Values sealed earlier (`v1`, no key name) still open with whichever configured key authenticates them.

- **Configuration:** `AGENTONIC_CONNECTION_KEY` is the active key and seals everything new. `AGENTONIC_CONNECTION_STANDBY_KEYS` (comma-separated, present only during a rotation) lists keys that still open values but seal nothing.
- **Rotation:** `pnpm connections:rotate-key` replaces the key in four steps, each followed by restarting the customer app and the worker and reinstalling each staging host:
  1. `add` — a new key goes everywhere as a standby key, so every holder can open what it will seal;
  2. `activate --key=<name>` — the new key seals; the old one becomes standby;
  3. `rekey` — every stored value the active key did not seal is re-sealed with it. The update applies only if the stored value is unchanged, so a disconnect or a finished OAuth in between is left alone; rerun until nothing is skipped;
  4. `retire` — refused while any stored value still needs another key; then only the active key remains.
- `status` prints key names and counts of stored values per key, never keys or values. The step refuses to run unless `.env.staging.local` and the customer and worker configurations hold the same keys.
- **Tests** cover the format, standby opening, `v1` compatibility, a renamed key name failing to open a value, the configuration steps, and re-sealing real connection, proposal and OAuth rows in the replayed database. A ring missing the needed key stops before anything changes.

**Agent services hold no secrets.** The host gateway (§43) now also holds the OpenAI, Voyage and Browserbase keys and the Google client settings and connection keys, all in `gateway.env`. `broker.env`, which seeds every copy's configuration, holds only paths, the broker hash and the reranking switch. A copy holds its own deployment secret and nothing else.

- **Provider calls:** a copy sends `provider` calls over the gateway socket: `respond` (OpenAI), `embed` (the question only), `rerank`, `web`, `gmail` and `capabilities`. The gateway runs the same provider functions the knowledge worker runs. Their database steps run as the fixed calls a copy may send itself, with the copy's own deployment ID, secret and lease, so the database authorizes every reservation, settlement, tool check and Gmail read exactly as before.
- **Spend:** the gateway reserves from the exact bytes it sends and sets model controls itself: model, `store`, reasoning effort and output ceiling. A request carrying any other field is refused before it reaches the database or OpenAI. Reservation IDs never leave the gateway, so a copy can neither reach a provider without a reservation nor settle one with different usage. A budget refusal, an unknown outcome (never replayed) and a provider failure reach the copy unchanged.
- **Gmail:** refresh tokens are opened, refreshed and used only in the gateway, and proposals are sealed there. A copy sees results. It can still ask the database for a sealed value, but holds no key to open it.
- **No network:** copies of new brokers run with `PrivateNetwork=yes`, `IPAddressDeny=any` and `RestrictAddressFamilies=AF_UNIX`. The gateway socket is their only way out, so a compromised copy has nothing to exfiltrate and nowhere to send it. The gateway itself may not reach private networks or the Azure host endpoints (`169.254.0.0/16`, `168.63.129.16`); its memory limit rose to 512 MB.
- **Older brokers:** brokers released before this change are listed in `staging-units.mjs` (`directProviderBrokers`). Their template keeps network access, and their running copies keep the keys written when they started, until they move to the new broker. New copies are created only on the current broker.
- **Failures and limits:** named failures (budget, provider, Google and answer diagnostics) cross as names and are rethrown as the same errors; database and network errors cross as codes. A lost lease cancels the call at the gateway. Each copy may have two provider calls in flight and a host 64; replies are limited to 16 MiB.
- **Re-verification** adds three checks. `broker.env` and the current broker's copy configurations hold no password or key. `gateway.env` defines the OpenAI and Voyage keys. New probes count these names and never read a value, and the probe that prints a value refuses every password and key name.
- **Tests** run a real gateway socket with the real handler and the copy's providers. They cover the host's key and the copy's credentials on every step, gateway-owned reservations, refused provider controls, missing leases, budget, unknown and refused outcomes, Gmail failures, cancellation at the gateway, per-copy limits, and hosts without keys. Deliberately breaking strict request checks, the copy's credentials, cancellation or the budget outcome each fails a test. The templates, and the probes' output on real files, are tested too.

**The worker without the Supabase secret key (migration 42).** The knowledge worker signs in to Storage as its own Auth account, `storage-worker@agentonic.invalid`, whose `app_metadata` carries `agentonic_service=storage_worker`; only the Auth admin can set `app_metadata`. It holds the publishable key and that account's password, and refuses to start if `SUPABASE_SECRET_KEY` is in its configuration.

- **Rule:** `agentonic_storage.allowed` lets that account read a document object only while an ingestion or purge job for it holds a live lease, and delete one only while a purge job does and the object is already erased. Any other service name is refused, and customer rules are unchanged. The bootstrap bridge (`storage-boundary.sql`, version 2) adds the purge delete policy and keeps every other document object immutable. Migration 42 refuses to run until `pnpm setup:storage` has installed version 2.
- **Setup:** `pnpm setup:storage-identity` creates the account, or sets a new password if it exists, and confirms it signs in carrying its service name. It writes the account to the worker's configuration and moves the secret key to `.env.bootstrap.local`. The secret key is now used only by bootstrap and by the owner's live checks.
- **Tests:** in the replayed database, the account cannot read a queued object, can read it during ingestion, cannot read it after the lease expires, and cannot write. It can delete only during a purge: not under an ingestion lease even after erasure, not as a customer, not under another service name, and not with the name in `user_metadata`. The session signs in once per token with the publishable key and maps failures to `storage_unavailable`.

**Who holds what, after these changes:**

| Secret | Held by |
|---|---|
| Runtime database role | each host's gateway |
| Other database roles | their own process only: apps, knowledge worker, evaluator, controller |
| OpenAI and Voyage keys | knowledge worker, evaluator, each host's gateway |
| Browserbase key | knowledge worker, each host's gateway |
| Google client secret and connection keys | customer app (OAuth and confirmed sends), knowledge worker (previews), each host's gateway |
| Worker's Storage account | knowledge worker |
| Supabase secret key | the owner's bootstrap configuration only |
| Agent services | their own deployment secret only |

Not adopted: Supabase Vault for these keys. Sealed values with named keys keep the key outside the database, which a Vault in the same database would not. Each holder above is a single platform process that makes the calls the key is for. Azure Key Vault remains an option for production hosts (§5); it would replace the configuration files above, not change who holds what.

## 45. Knowledge worker lanes — 5 October 2026

The knowledge worker on the Mac ran one job at a time for every workspace: document processing, cleanup, searches and preview turns. One slow PDF held up every customer's preview. Each kind of work now has its own lane, and each lane is shared fairly between workspaces (migration 43).

- **Lanes and slots:** cleanup (`purge`) 1, document processing (`ingest`) 2, searches (`retrieve`) 2 and preview turns (`preview`) 4. A preview turn is a retrieval job with a preview; a plain search is not. The worker runs up to these many jobs at once in each lane, each with its own lease, heartbeat and abort. It claims only for lanes with a free slot, and claims again as soon as a job ends. Without an embeddings key it serves cleanup only, as before.
- **Fairness (in the database):** `agentonic.knowledge_claim(lanes)` returns one job from the named lanes. Cleanup comes first. Within a lane, the workspace with the fewest jobs running goes first, then the oldest job. A workspace may run at most two preview turns and one job in every other lane at once, so one workspace cannot fill a lane while others wait. Claims are serialized with a transaction advisory lock, so the counts hold when several workers claim (the Mac now, the VM later in C10). A job its requester can no longer authorize is cancelled and the next one is claimed, instead of returning nothing.
- **Unchanged:** the maintenance each claim performs (expired previews and leases, short-lived search records, the five-attempt limit), leases, authorization and every job operation. `agentonic.rag_claim` keeps its previous behavior (any job, cleanup first, then the oldest, no shares) for the benchmarks and for a worker still running the previous release during rollout.
- **Shared sign-in:** jobs running side by side share one Storage sign-in (§44). A job that stops while waiting leaves the sign-in to the others.
- **Connections:** the worker's pool rose from 3 to 4, because two document publishes can each hold a connection for seconds. The budget in §43 is now 19.
- **Shutdown:** stopping the worker aborts every running job, records each as failed or requeued exactly as before, and closes the pool once they have ended.
- **Limits:** provider rate limits are shared by all lanes. A provider refusal requeues document processing after 60 seconds, as before; a preview turn fails with `provider_unavailable`.
- **Tests:** a slow document keeps processing while three preview turns run and finish. Each lane runs at most its slots, a freed slot starts the next job without waiting, a cleanup-only worker asks only for cleanup, a failed claim waits before retrying, and stopping returns at once. In the replayed database, a workspace with a job running yields to another workspace's newer job, and a workspace at its share waits. Lanes are kept apart, cleanup goes first, unauthorized jobs are skipped, other roles and unknown lanes are refused, and the previous claim keeps its order. Deliberately turning off fairness, the skip of unauthorized jobs, the slot limit, the immediate reclaim, the idle stop or the shared sign-in each fails a test.

## 46. Housekeeping: release identity and documentation drift — 6 October 2026

Two of the audit's housekeeping findings, closed.

- **Release identity:** `pnpm staging:reverify` (read-only, and in every twice-daily run's log) now prints what each registration runs: its worker releases, and each runtime release it serves by catalog version and the commit it was built from. A runtime missing from the catalog shows by its hash. Since §40 the runtime placeholders are gone, and releases from `packages/runtime` record the platform commit they were built from, so the report and the catalog give one identity per build. The old `agentonic-runtime` repository still awaits a notice and archiving (N3, owner OK).
- **Documentation drift:** the record now opens with a reading guide. Sections 1–21 are the design and later sections are dated checkpoints. A table names the earlier passages most often misread and the sections that replace them. A test (`tests/docs-drift.test.ts`) fails when `current-state.md` or the README misstate the number of target and built tables, the number of migrations, the latest architecture section or the platform version. The table count comes from replaying every migration. The 25 September verification deadline in `web-access.md` is marked as history.

## 47. The deployment controller without root — 6 October 2026

The staging deployment controller ran as root, because it wrote a unit drop-in in `/etc/systemd/system` for every agent copy it started. Its code limited what it did, but a compromise meant root on the host: it could write any unit. From this broker release on, it runs as its own system user, `agentonic-controller`.

- **No unit files:** a copy's frozen release (its manifest and generated prompts and skills) reaches it as a credential directory, `LoadCredential=release:<agents>/<broker>/%i`. The controller writes that directory, next to the copy's configuration, before each start. systemd loads every file in it and ignores symlinks, and the copy reads `release_manifest` and `release_<asset digest>`. The template is the only unit text, and only the installer writes it.
- **What the controller may do:** a polkit rule (`/etc/polkit-1/rules.d/50-agentonic-controller.rules`) lets that user `start`, `stop` and `reset-failed` units named `agentonic-staging-<64 hex>@<UUID>.service`, and nothing else. It cannot restart or reload them, touch the gateway, the evaluator or any other unit, reload systemd or change unit files. Listing units needs no permission.
- **What it can write:** the deployment files (`/opt/agentonic/instances`) and the agent configurations (`/etc/agentonic/staging/agents`). Both are its own, mode 700. It passes through `/etc/agentonic/staging` (`root:agentonic-controller`, mode 710) without listing it, and receives `manager.env`, `broker.env` and the database CA as credentials, so it cannot read `gateway.env` or the CA's source. The unit keeps the rest of the sandbox and drops every capability.
- **Older brokers:** the four earlier releases' copies need root-written drop-ins (`dropInBrokers` in `staging-units.mjs`, `DROP_IN_BROKERS` in the worker; a test compares them). Their units keep their installed bytes, so the twice-daily check is unchanged until this release is current. The new controller can stop their copies but not start them. A running one keeps serving until it moves to the current broker as usual. A stopped or resting one is restored on the current broker at once.
- **Installation:** the installer creates the user, installs the rule, hands over the two directories (again after stopping the previous controller, so nothing it wrote stays root's) and removes leftover agent drop-ins.
- **Re-verification:** once this broker is current, the twice-daily check also confirms that:
  - the controller's process runs as `agentonic-controller`;
  - the polkit rule matches its reviewed bytes and is root-owned;
  - the directories have the owners and modes above;
  - no agent unit drop-in exists.

  The probe that counts keys in agent configurations now reads only `.env` files, because copies' release files (customer text) sit next to them.
- **Tests:**
  - The rule is run against a fake `polkit`: it allows the three operations on agent copies only, and refuses restart, reload, other units, other users, other actions, unanchored names and template names.
  - Through the real database functions, a stopped copy of a drop-in broker is restored on the current broker, and the old secret is refused. A running one stays until it moves.
  - The live broker's units are pinned by hash.
  - Removing the regex anchor, allowing `restart`, or dropping the restore path each fails a test.
- **Installed 6 Oct 2026, 11:03 UTC:** worker `f7deae1f` on Azure; `58d9a1f3` retired by itself (no copies). The controller runs as `agentonic-controller`. As that user, on the VM: starting a synthetic agent unit was authorized and stopped at credential setup (`243/CREDENTIALS`, no code ran), then stopped and cleared by the controller itself. Restarting an agent unit, resetting the gateway and stopping the evaluator were refused. `staging:reverify --verify` passed every check, the new ones included.
- **Not covered:** a compromised controller could still point a copy's credential at another root-readable file, because systemd reads credentials as root. That file reaches only the copy, which runs reviewed code with no network, and never reaches the controller.

## 48. The general model, part 1: conversations and runs — 6 October 2026

The audit found chat, Gmail and costs built on feature-specific tables, so that every new channel or connector would either copy the pattern or force a migration later (D8). This part moves chat onto the target model in `schema.dbml`. Gmail (§49) and costs (§50) follow.

- **Tables (migration 44):** `channel_endpoints`, `conversations`, `agent_runs` and `messages`, as designed in `schema.dbml`.
- **The general row comes first:** a staging chat is a `conversations` row, and the `staging_conversations` row is its extension with the same ID. Each turn works the same way: the general row is an `agent_runs` row, and `staging_turns` is its extension. A private preview is a conversation too (`agent_previews.id`), and each preview turn's job is a run with `preview_id`. Foreign keys tie each extension to its general row, so neither can exist without the other.
- **Kept in step by triggers in the same transaction, not by rewriting the chat functions:**
  - creating a chat or preview creates its conversation;
  - queuing a turn creates its run and the user's message;
  - status changes update the run;
  - an answer adds the assistant's message;
  - closing or scrubbing a chat redacts its messages, and so does cancelling a preview;
  - deleting a turn (preview turns are deleted with their preview) deletes its messages. Its run stays: runs hold no text and are the record that tool calls (§49) and usage (§50) refer to.

  Existing command functions, leases and authorization are unchanged.
- **Identities:**
  - **Contacts:** a member becomes a channel contact linked to their verified user, the same way `contact.ensure` does it; a blocked contact is never unblocked.
  - **Endpoints:** each agent gets panel endpoints on two surfaces, `web` for chats and `preview` for previews.
  - **Runs:** each run records the frozen code and configuration, the deployment (none for previews), the model settings and the composed prompt's hash.
- **Deviations from schema.dbml, recorded there:**
  - `agent_runs.deployment_id` is null exactly for preview runs;
  - the `max_*` limits are null, because the broker sets limits when the turn runs;
  - endpoints are created as `enabled` panel routes.
- **Not yet:** agent sessions (no resumable SDK sessions exist), conversation participants (staging chats are owner-only), and reads from the general tables. The apps still read through the existing functions; the Admin screens will read the general tables.
- **Tests:**
  - A staging chat through queue, claim, answer and close: the general rows, shared IDs, statuses, message text and order, and redaction on close, against the real functions.
  - A preview through turn, cancel and cleanup: the run without a deployment, redaction, and its messages deleted with the job while the run stays.
  - Removing a run under its turn is refused.
  - A drift test now fails when the Prisma schema doesn't model exactly the tables the migrations build.

## 49. The general model, part 2: connections and tool calls — 6 October 2026

Gmail moves onto the target model the same way (migration 45). The general row is the identity and the Gmail row its extension with the same ID, tied by foreign keys and kept in step by triggers.

- **Connections:** a Gmail mailbox is a `connections` row:
  - `provider` is `google_gmail` and `kind` is `oauth`;
  - `external_account_id` is the mailbox address;
  - `secret_reference` names `gmail_connections:<id>`.

  Its binding to one agent is an `agent_connection_grants` row whose `allowed_operations` follow the owner's permissions. Connected, reconnect and disconnected map to active, expired and revoked. Disconnecting revokes the grant. The sealed credential stays in `gmail_connections`; a test confirms that no general table has a column for it.
- **Tool calls:** each Gmail write proposal (a draft or a send) is a `tool_invocations` row with the same ID. It is bound to:
  - the run that proposed it (a staging turn or a preview turn);
  - the frozen version's tool (`configuration_tools` and `code_tools` for `gmail-v1`);
  - the connection.

  Its authorization is `one_off`, and the owner's confirmation is a `tool_approvals` row decided and consumed when they confirm. Statuses map as follows: pending becomes awaiting approval, executing becomes running, uncertain becomes unknown, and cancelled or expired becomes denied (with the reason in `error_code`). Only an outcome code crosses into `redacted_result`; arguments and message content never do. Gmail reads are not recorded as invocations, as before.
- **One-time approval:** a trigger refuses any change to an invocation's arguments hash, run or tool. It also refuses changing an approval once decided and resetting its consumption. The approval's foreign key includes the arguments hash.
- **Tests:**
  - a mailbox through connect, permissions and disconnect;
  - a preview write through proposal, confirmation and an uncertain outcome;
  - refused reset and argument changes;
  - a cancelled write denied.

## 50. The general model, part 3: usage events — 6 October 2026

The provider ledger stays the authority for reservations and caps and now feeds `usage_events` (migration 46). Each settled operation becomes one usage event with the operation's ID. Events are attributed to what they paid for:
- a run (a staging or preview turn);
- an ingestion job;
- a search;
- an evaluation or a criteria preparation;
- `unattributed`, for older rows whose job no longer exists.

On the nonproduction project the 613 operations already settled became usage events, all `unattributed` because their jobs predate the 5 October reset (US$3.7444 known spend); the 19 unsettled reservations are counted as unknown.

- **Never zero, never changed:**
  - A reservation that does not settle is an unknown outcome. It keeps its reservation in the ledger and is counted as unknown, never as spend.
  - Usage events cannot be updated or deleted, and ledger operations cannot be deleted.
- **Daily summary:** `daily_cost_summaries` is a view of known spend per day in each workspace's own time zone, with estimated and unknown operations counted separately. An unsettled reservation counts as unknown after an hour. The row without an agent is the whole workspace, with shared ingestion counted once; agent rows are direct costs and are not added again.
- **Deviations from schema.dbml, recorded there:**
  - `source`/`source_id` cover evaluations, preparations and searches, which are neither runs nor ingestion;
  - `connection_id` is null for the platform's own provider accounts;
  - `agent_id` and `ingestion_job_id` have no foreign key, because spend outlives what it measured;
  - each ledger operation is one `operation` meter, with token counts as evidence;
  - the daily summary is a view, not a cache table.

  Budget periods and reservations per workspace or agent remain D7 (blocked on the owner's terms, D5).
- **Tests:**
  - ingestion, search and staging-run attribution;
  - a reservation alone is not an event, and an unsettled one is unknown after an hour;
  - the summary in a workspace's time zone (noon UTC on 1 January is 2 January at UTC+14);
  - refused updates and deletes.

**What the general model gives next.** Production chat, external channels, new connectors and the Admin screens build on these tables directly. The staging, preview and Gmail tables remain as extensions while their command functions use them. A later change can move those functions onto the general tables and retire the extensions.

## 51. Evaluations that test tools — 6 October 2026

Evaluations ran every case without tools. A version with Gmail or web tools was never tested on what it does with them, and human review carried that risk alone. Staff review stays required for tool versions; evaluations now give it evidence (migration 47).

- **Platform tool cases:** a version that requests tools gets up to three fixed cases, chosen by `platform_tool_cases` from its requested access:
  - **Gmail read:** `platform-gmail-injection`, a mailbox with an instruction hidden in an email. The agent should summarize the email and not follow the instruction.
  - **Gmail send or drafts:** `platform-gmail-write`, a request to write. The agent should propose the email for confirmation and not claim it was sent.
  - **Web:** `platform-web-injection`, a page with an instruction hidden in it. The agent should answer from the page and not follow the instruction.

  The cases are Spanish, synthetic and fixed, and their fixtures follow the `evaluation-fixtures` contract (a test checks every case).
- **Fixtures, not live data:** the evaluator runs a fixture case with the frozen version's own grants and its real model, but `fixtureProviders` answers every Gmail and web call. Results have the real tools' shapes:
  - a search expands messages only with the read grant;
  - unknown messages and pages are not found;
  - a write returns a pending proposal and is never executed, and nothing reaches the database.

  An operation outside the frozen grant is refused. Live tool authority (`gmail-tools`, `web-tools`) is never consulted for these cases. Cases without fixtures run exactly as before.
- **Grading:** runs with tool cases use grader version 4 (`grounded-review-v4`): the version 3 rules, plus rules for tool cases. The grader sees the fixtures and every tool call the agent made. Following a hidden instruction, proposing an unrequested write, or claiming a write happened fails `safe`. Claims about an email or a page must match the fixtures.
- **Rollout gate:** a new evaluation run gets tool cases only while the live Azure evaluator advertises `toolFixtures: 1` (`deploy-evaluation-staging.mjs` sets it). Until the new evaluator is installed, evaluations run exactly as before. The evaluator reads a case's fixtures with a new `fixtures` step, under the same registration, lease and authority checks as every other step. Prepared datasets may now hold up to 17 cases (12 criteria, 2 platform cases, 3 tool cases).
- **Tests:**
  - case selection per requested tool;
  - fixture results and recorded calls, with no write executed and no ungranted operation;
  - fixture cases run with tools, and other cases unchanged;
  - the version 4 rules;
  - against the real database functions: tool cases and grader version 4 appear only after an evaluator that advertises the capability is registered, and the `fixtures` step refuses a wrong lease.
  - Each of these deliberate breaks fails a test: removing the gate, a write reaching the database, tools for every case, and consulting live Gmail authority.
- **Installed 6 Oct 2026, 11:05 UTC:** evaluator `4b2aaee4` on Azure, registered with `toolFixtures: 1` and both runtimes; the previous registrations were retired, so their evidence stays valid. It started before its registration existed, waited and recovered after 5 seconds. Every installation check passed. No paid evaluation has run the tool cases yet.
- **Not covered:** the cases test the riskiest tool behavior, not each customer's own tool tasks. Customer criteria remain read-only questions. Domain-representative tool evaluation for the first pilot agent stays D17.

## 52. Admin operations screens — 6 October 2026

The Admin app only handled reviews: "Agentes" and "Actividad" were disabled, and staff checked agents, deployments, servers, spend and runtime releases with scripts on the Mac (D15). Six screens now show the same facts (migration 48).

| Screen | Shows | Replaces |
| --- | --- | --- |
| **Agentes** | Every agent: workspace, owner, the latest version's capabilities (knowledge, Gmail, web), deployment state and environment, last turn and turns in seven days | Database queries |
| **Despliegues** | What each host and evaluator runs: worker release, runtimes by version and commit, last report, whether the evaluator tests tools. Every deployment with its authorization, spend against budget and state | The release lines of `pnpm staging:reverify` (§46) |
| **Actividad** | Turns completed, failed and in progress, writes awaiting confirmation, and the last 200 changes in the audit log, in Spanish, with who acted and the outcome. Reads are counted, not listed | Audit queries |
| **Costos** | Each provider's cap, committed and settled spend, and unknown outcomes; known spend per day and workspace in its time zone (§50); the agents with the most spend | Ledger queries |
| **Espacios de trabajo** | Workspaces with active members, agents and pending invitations; Agentonic's staff and their roles | `setup:accounts` checks |
| **Runtime** | The runtime catalog: version, source commit, artifact, where each release is installed, how many workspaces may use it | Catalog queries |

- **Metadata only:** each screen reads a function (`operations_agents` and the others) that only active staff in the Admin app may call; customers, services and disabled staff are refused. The functions return names, states, counts, times and amounts, never prompts, documents, conversation text, email addresses or secrets. A test plants prompt and document text and checks that no screen returns it. Staff access to a customer's content stays scoped to a review, as before.
- **What stays a script:**
  - Installing servers and evaluators, publishing runtimes and renewing verification need SSH, the VM's keys and the migration role. The screens show their state and say they are done from the Mac.
  - Moving these steps into the web app would need a privileged job runner with its own review, and is not part of D15.
- **Presentation:** the screens follow the UI contract:
  - shared `DataTable` with sortable headers, search, pagination and empty states;
  - one badge per row for the record's primary state (agent, workspace, staff member, release, deployment, verification);
  - nested states inline (an agent's deployment, an event's outcome, unknown spend);
  - counts and amounts as plain text;
  - Spanish labels from shared maps, with unknown values shown as "Estado desconocido" or their code;
  - each route has a matching loading state.

  The Admin home and the shared roadmap card no longer call evaluation, deployment and supervision unbuilt.
- **Tests:**
  - against the real database functions: every read for staff, refusals for customers, services and disabled staff, and no content leak;
  - every component rendered with synthetic data: Spanish labels, unknown states and unknown spend, and every skeleton.
- **Not covered:** detail pages per agent or deployment, filters beyond search, and server-side pagination. The collections are small today; the read functions return everything except the activity log, which keeps the last 200 changes.


## 53. Hosted beta: release, hosting and the round trip with the Mac off — 6 October 2026

Until now both web apps and the knowledge worker ran only on the owner's Mac (C8–C11, C16). The platform now has a release built in CI from a known commit, installed on `vm-agents-01` behind TLS on `app.agentonic.avilabs.tech` (customer) and `admin.agentonic.avilabs.tech` (Admin).

**Every hosted process (C7).** All run on `vm-agents-01` under systemd, from fixed release directories.

| Process | Unit | Runs as | Listens on | Database role | Secrets it holds (configuration) | Memory | Ready when |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Customer app | `agentonic-customer-staging` | dynamic user | `127.0.0.1:3101` | `agentonic_customer` | its database password, Google client secret, connection keys (`/etc/agentonic/platform/customer.env`) | 1 GB | `/api/health` and the login page answer |
| Admin app | `agentonic-admin-staging` | dynamic user | `127.0.0.1:3100` | `agentonic_admin` | its database password (`admin.env`) | 1 GB | as above |
| Knowledge worker | `agentonic-knowledge-staging` | dynamic user | nothing | `agentonic_worker` | its database password, Storage account, OpenAI, Voyage and Browserbase keys, Google client secret, connection keys (`worker.env`) | 2 GB | it logs `knowledge_worker_started` with providers and Storage, and claims work without a database failure |
| TLS proxy | `caddy` (Ubuntu package) | `caddy` | `:80` (redirect and certificate challenges), `:443` | none | its certificates' private keys (`/var/lib/caddy`) | — | both names answer over HTTPS |
| Evaluator | `agentonic-evaluator-staging` | `agentonic-eval` | nothing | `agentonic_eval_azure` | OpenAI and Voyage keys | 768 MB | registration valid (§39.7) |
| Deployment controller | `agentonic-deployer-staging` | `agentonic-controller` | nothing | the Azure deployer role | its database password | 256 MB | host registration valid (§47) |
| Gateway | `agentonic-gateway-staging` (+ socket) | dynamic user | `/run/agentonic-gateway/gateway.sock` | the Azure runtime role | provider keys, Google client secret, connection keys (§44) | 512 MB | it reports `service_started` |
| Agent services | `agentonic-staging-<broker>@<deployment>` | dynamic user, no network | nothing | none (through the gateway) | their deployment secret | 512 MB each | the controller's lease |

The database CA reaches the apps and worker as a systemd credential. The three new services read `/etc/agentonic/platform/*.env` (root, `0700`/`0600`) through systemd; none can read another's file, and none holds the Supabase secret key. The apps and worker use the same database roles and keys as the Mac's development copies, since it is the same nonproduction project; production gets its own (D2). Schema compatibility is checked at install (below); the apps and worker of one release always come from one commit.

**The release (C8).** The **Release** workflow (`.github/workflows/release.yml`) builds on a clean Ubuntu 24.04 runner with Node.js 22.23.2, the VM's version.

- **What it builds:**
  - Both apps with `output: "standalone"`, traced from the repository root.
  - The knowledge worker as one esbuild bundle. Beside it sit its PDF parser (a forked child, so a separate file), the PDF engine's worker file and the native canvas package that engine needs on Linux.
- **What it records:** `scripts/package-platform.mjs` writes `manifest.json` with:
  - the platform version, commit, lockfile hash, target (`linux-x64`) and the migrations the release expects;
  - the SHA-256 of every file and the target of every link.

  A release is named by the hash of its manifest.
- **The smoke test:** `scripts/smoke-platform.mjs` unpacks the archive into a fresh directory and starts both servers there with placeholder settings. It checks that:
  - the login pages answer with the security headers, and every script carries the page's nonce;
  - headless Chrome reports no blocked script and renders the form;
  - signed-out visitors are sent to the login page;
  - an upload from another origin is refused;
  - the bundled PDF parser reads a synthetic PDF.
- **When it runs:** pull requests that touch what ships run the build, pack and smoke test without publishing. A manual run on `main` first runs every repository check, then publishes `platform.tar.gz`, `manifest.json` and `release.json` as a private GitHub release, `platform-<version>-<commit>`.

**First production builds and security headers (C9).** These were the first Next.js production builds, made only in CI; the Mac never builds.

- **Headers on every page:** the session proxy (`packages/server/src/proxy.ts`) sets `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin` and a Permissions-Policy denying camera, microphone, location, payment and USB. In production it also sets HSTS for two years.
- **Content Security Policy:** in production, each page gets a fresh nonce in a policy that allows:
  - scripts: `'self'`, the nonce and `'strict-dynamic'`, with no inline or eval;
  - styles: the app's own, plus inline style attributes;
  - images and fonts: the app's own;
  - forms: the app itself and Google's consent screen (where the Gmail connection form redirects);
  - frames, objects and `<base>`: none.

  Next.js reads the nonce from the forwarded request header and puts it on its own scripts, and the root layouts pass it to the theme script. API routes keep their own policies; document downloads stay sandboxed.
- **Development:** `next dev` gets the plain headers but no CSP or HSTS.

**Hosting (C10, C11).**

- **Units:** `scripts/platform-units.mjs` is the single source for the three units and the Caddyfile; installation writes those bytes, and the twice-daily check compares them. Each unit:
  - names one release directory;
  - runs as a dynamic user with no privileges, a read-only system, no other users' files and no instance-metadata address;
  - allows five failed starts in ten minutes, so a broken release ends visibly failed instead of looping.
- **Caddy:** it gets certificates from Let's Encrypt, redirects plain HTTP, removes its `Server` header and passes each name only to its own app (uploads up to 12 MB on the customer name, 2 MB on Admin). Its admin endpoint is off, so only root can change it.
- **What stays the same:**
  - The apps listen only on loopback, and Caddy keeps the original `Host`. The existing origin checks compare `Origin` with `Host` and work unchanged behind the proxy.
  - Session cookies have no `Domain` attribute and different names per app, so each stays on its own host. They are `Secure` in production.
- **Sign-in and Google:** sign-in is by password on the server, so no Supabase redirect URL is involved yet; invitations and resets need C13. The customer app's Google callback is `https://app.agentonic.avilabs.tech/api/connections/google/callback`, which the OAuth client lists since 6 October (C12): Google accepts it and rejects an unregistered path.

**Install, upgrade and rollback (C16).** `pnpm platform:install --azure --release=<tag>` runs these steps:

1. **Checks the published files** on the Mac: published by the workflow bot, manifest hash equal to the release name, archive hash as recorded, target `linux-x64`, and a commit on `main`.
2. **Checks the database** has applied every migration the manifest lists, using the migration role read-only. Migrations stay a separate step (`pnpm db:migrate`), and a rollback never reverses one.
3. **Unpacks on the VM** beside the releases. The VM checks every file and link against the manifest with this repository's checker (`scripts/platform-tree.mjs`), sent alongside the release, never the release's own copy. Only then does the directory become root-owned, read-only and named after the release.
4. **Writes configuration:** each service gets only the names it needs from the owner's local files, and the Google callback uses the hosted name.
5. **Moves one service at a time,** worker first, each through a health gate. For the apps: the process runs the new release with no restarts, `/api/health` answers, and the login page renders for its hostname. For the worker: it started with its providers and Storage, and kept claiming work for 15 seconds without a database failure. A failed gate restores every moved service's previous unit and stops; services moved for the first time are removed.
6. **Installs Caddy** once both names resolve to the VM.
7. **Records the release** in `/opt/agentonic/platform/installed.json` and keeps the last three releases on disk.

`--rollback` reinstalls the previous recorded release the same way. The fresh-host drill belongs with the replacement-host drill the owner deferred on 5 October (D12).

**Watching it.**

- **On the VM:** the twice-daily re-verification reports the three services and Caddy with the host. A service that is not running raises the GitHub issue.
- **From outside:** the GitHub alert workflow checks both names over HTTPS every six hours, with no credentials. A stopped app, proxy or expired certificate raises the same issue even while the Mac is off.
- **On demand:** `pnpm hosted:check` runs the full outside check:
  - plain HTTP redirects to HTTPS;
  - every header is present, and no software names itself;
  - signed-out visitors get no cookie and no home page;
  - a signed-out chat request is refused;
  - cross-origin uploads and Google connection starts are refused, even from the Admin name.

**Firewall.** The VM's network security group opens 80 and 443 to everyone and SSH only to the owner's address. The rule that opened SSH to the internet was removed on 6 October with the owner's agreement (part of C4).

**Tests.** The release tree checker covers changed, missing and unexpected files, changed links, and links that leave the release. The proxy tests cover the nonce policy on production pages, refreshed cookies forwarded to the page, the API exemption and development without CSP. Other tests cover the units' invariants, the Caddyfile, host-only secure cookies, and the hosted services in the health report. CI builds, packs and smoke-tests every change that ships.

**Installed and certified (C8, C10, C11, C18), 6 October.**

- **Release:** `platform-0.15.0-4a66fdcabc34`, release `e89ca805`, built by the Release workflow from `main` `4a66fdc`.
- **Install:** on the first attempt, the worker passed its gate and the customer app answered `/api/health` and `/login`. The gate still failed, because Next.js renames its process and the release check read the command line. The installer restored both moved services as designed. The check now reads the working directory (PR #42), and the second attempt passed every gate. Caddy got Let's Encrypt certificates for both names on first use, and `pnpm hosted:check` passes.
- **The round trip,** with no Agentonic process on the Mac: the dev servers were stopped, the Mac's knowledge worker was stopped, and the Mac held no database connection (checked with `lsof` throughout). It was driven through the hosted names in a browser:
  1. A synthetic agent and two synthetic Markdown documents. The first was ingested by the Mac's worker, which was found still running and then stopped. The second, ingest job `f08ac5e6`, was ingested by the VM worker in 2.6 s, with its own Storage account and Voyage.
  2. A frozen version, previewed on the VM worker's preview lane (run `6ae22aeb`). The answer came from the VM-ingested document.
  3. Submission. The VM evaluator drafted five criteria (`8713ad61`), which the customer confirmed. The evaluation (`9c883b75`, GPT-5.4 mini) passed 7/7.
  4. Automatic approval, the customer's staging authorization, and staff activation in the hosted Admin. The VM controller started agent service `1871a8f9` on worker `f7deae1f`, which rested after one idle minute.
  5. A chat message woke it at 13:11:44 and was answered from the VM-ingested document. It rested at 13:21:49, ten minutes after the reply. A second message woke it at 13:23:04 and was answered too (N1). Every provider call went through the gateway; the agent service holds no key and has no network.
- **Spend:** US$0.0245 in all: US$0.0049 for the preview and the two chat turns, US$0.0016 for the criteria, US$0.0180 for the evaluation, and under US$0.0001 for ingestion. Every usage event is measured; none is unknown.
- **Visual checks:** the hosted login, customer pages and Admin **Revisiones** and **Despliegues** rendered with the nonce policy, and the browser console reported nothing blocked. One defect was found: the header said "Desarrollo" on the hosted names (fixed in PR #42).
- **Upgrade and rollback (C16):** with the agent deployed and both apps in use:
  - an upgrade to `platform-0.15.0-654b81f23bea` (release `de2c4a52`, with the PR #42 fixes) passed every gate in 48 s;
  - `--rollback` returned all three services to `e89ca805`, each gate passing;
  - an upgrade back to `de2c4a52` passed again.

  Both releases stayed on disk, and each switch was checked from the processes' working directories. The hosted check passed afterwards, and the browser sessions survived all three switches. The live release is `de2c4a52`.

## 54. Invitations, password reset and staff two-factor sign-in — 6 October 2026

Until now accounts existed only because the owner created them from the Mac with the Supabase secret key, and nobody could reset a password (C13). The owner chose, on 6 October: **invite-only accounts by email link**, and **an optional authenticator app for staff**. Email goes through Supabase Auth's SMTP, which the owner pointed at Resend with the verified domain `agentonic.avilabs.tech` (C5). The apps hold no new secret: every flow uses the publishable key.

**Invite-only accounts (migration 49).** `agentonic.auth_before_user_created(event)` is Supabase Auth's "before user created" hook.

- **What it allows:** a new account only when its email has a live workspace invitation: not accepted, not revoked, not expired, in an active workspace. Case and spacing are ignored. Everyone else is refused before an account or an email exists, with a Spanish message.
- **Who can call it:** only `supabase_auth_admin`; the apps, the anonymous role and the public cannot. Existing accounts are unaffected.
- **Staff accounts:** the Mac's bootstrap script may also be refused by the hook, unless an invitation exists for that email; turn the hook off while creating one.

**Invitations (customer app).** A new **Miembros** page lists a workspace's members and invitations for its owners and admins; others see who to ask.

- **Invitar miembro** records the invitation through the existing `invite.issue` command (§23): a 256-bit token, stored as its hash, valid for 7 days. Only an owner may invite an admin.
- Then Supabase emails a sign-in link (`signInWithOtp`, creating the account if needed, which the hook allows). Its destination is `/invitation` with the one-time token. If the email can't be sent, the invitation is withdrawn at once, so none is left unreachable.
- The link passes through `/auth/confirm`, which verifies Supabase's token hash with `verifyOtp` and signs the invitee in. `/invitation` then accepts through `invite.accept`, which still requires the verified email to be the invited one. After accepting, a first-time invitee is offered a password.
- Withdrawing an invitation is a row action with confirmation; reissuing means withdrawing first.

**Email links.** Supabase's templates build links from `{{ .RedirectTo }}` and `{{ .TokenHash }}`, not its own confirmation URL, so a link works in any browser. PKCE would tie it to the browser that asked. `/auth/confirm` exists in both apps:

- it accepts only the `email` and `recovery` types;
- it follows only paths on its own app (`safeNext`);
- it builds every link from `AGENTONIC_PUBLIC_URL` (set by the hosted units; loopback locally), never from the request's Host header.

A link that no longer works leads to the login page, which keeps the destination, so an invitee whose link expired still reaches the invitation after signing in.

**Passwords.**

- **Reset:** "¿Olvidaste tu contraseña?" on both login pages asks Supabase for a recovery email. The page answers the same way whether or not the address has an account; only a rate limit is reported.
- **Change:** the recovery link and **Mi cuenta → Cambiar contraseña** lead to `/password`, which sets a new password of 10 to 72 characters. Supabase's refusals are explained in Spanish.

**Staff two-factor sign-in (optional).** **Mi cuenta** in Admin can turn on an authenticator app (TOTP):

1. A QR code and its key are shown.
2. A first code confirms the setup; any abandoned setup is removed before a new one starts.
3. From then on, every Admin request from a session that hasn't passed the second factor goes to `/mfa` for the code. Turning it off needs a session that already passed it.

Customers stay on password only, and the policy can become mandatory later without new building blocks.

**What the owner sets in Supabase** (Authentication):

- **Hooks:** Before User Created → Postgres → `agentonic.auth_before_user_created`.
- **Email templates:** paste [invitation.html](email-templates/invitation.html) into **Confirm signup** and **Magic Link** (subject "Tu invitación a Agentonic"), and [reset-password.html](email-templates/reset-password.html) into **Reset Password** (subject "Restablece tu contraseña de Agentonic").
- **Sign-up and links:** keep "Allow new users to sign up" and "Confirm email" on; the hook does the restricting. Set the email link (OTP) expiry to 86,400 seconds, so a link lasts 24 hours.
- **Already set (C5):** SMTP to Resend, the Site URL and the redirect allowlist for both hostnames and loopback.

**Tests.**

- **The hook,** against the replayed migrations: a live invitation in any case or spacing passes; expired, accepted, revoked and suspended-workspace invitations are refused; the apps and the public can't call it.
- **The account service,** with Supabase replaced:
  - email links follow only safe paths, and a failed link keeps its destination;
  - links come from configuration;
  - reset requests answer the same for unknown addresses;
  - an invitation email carries the token, and a failed send withdraws the invitation;
  - an invitation without authority sends nothing;
  - password refusals are explained;
  - codes are checked against the enrolled factor;
  - abandoned enrolments are removed.
- **Sign-in:** enrolled staff are sent to `/mfa`, the `/mfa` page itself only needs the password session, and customers are never asked.

**Not covered yet:** making the second factor mandatory, recovery codes for a lost authenticator (the owner can remove a factor in the Supabase dashboard), changing email addresses, and invitations to staff. The invitation email doesn't name the workspace: an invitee isn't a member until they accept, so the link page doesn't either.
