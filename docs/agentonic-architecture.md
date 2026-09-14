# Agentonic — architecture and implementation decisions

**Status:** accepted direction; shared foundation, step 3 customer authoring and initial step 3.5 staff review implemented; runtime execution pending (§24) · **Decision date:** 2026-09-13 · **Owner:** Agentonic founder

This is the authoritative architecture decision record for the initial Agentonic platform. It records the owner's accepted choices and the implementation judgment delegated to Codex for scope, operational details and corrections. Its authoritative schema companion is [schema.dbml](schema.dbml).

This record and its reconciled DBML supersede the earlier Claude and Codex proposals, which have been removed from this directory at the owner's request. Read the two files together: this record defines authorization, operational behavior and SQL-only requirements; the DBML defines the relational model. Accepted decisions are requirements for implementation, not a claim that every target capability is enabled. Sections 22–26 record the implemented slices, page-load audit and authoring UI follow-up.

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

The companion now names 70 tables: 69 launch entities and one conditional entity, `document_contact_access`. Deferred features are omitted. The conditional table has no incoming references from launch tables, so excluding it leaves a complete launch FK graph. A table is not a requirement for a separate CRUD screen. Deferred features must not require permissive placeholder policies.

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

[schema.dbml](schema.dbml) is the reconciled model. It contains 70 explicitly scoped tables and 239 foreign keys under `agentonic`. PostgreSQL-specific controls below remain migration work; exporting the diagram alone does not produce a production-ready database.

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

Implement by useful end-to-end workflows. The 70 tables are not 70 screens, and the entire schema does not need one initial migration. Each feature receives its required relationships and enforcement before it is enabled. If circular relationships cross migration stages, add those foreign keys in the later stage before enabling affected workflows; do not ship permissive temporary policies.

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

**Owner direction, 2026-09-13:** follow the rulebook in `Dev/acachuchazo-admin/docs/ui/ui-contract.md`, with the new Agentonic shadcn preset below. That source was read in full, including its detail-page conventions. This section records the applicable rules locally so implementation does not depend on another checkout. Keep the two authoritative documents in `/docs`; this UI decision requires no schema change. These are the complete UI implementation requirements. Section 22 records the implemented foundation subset and checks; later screens must meet the same rules.

### 21.1. Preset, primitives and styling

Owner-supplied initialization command:

```sh
pnpm dlx shadcn@latest init --preset b1GfVg2Oe --template next
```

The official CLI's read-only `preset decode b1GfVg2Oe --json` resolved the base preset on 2026-09-13. The table below includes the subsequent owner override from large to default/medium radius:

| Setting | Agentonic |
|---|---|
| Style | Mira |
| Base color | Mist |
| Theme | Sky |
| Font | Figtree; headings inherit |
| Icons | Lucide |
| Radius | Default / medium (`--radius: 0.625rem`), owner override |
| Chart color | Amber |
| Menu color / accent | Default / subtle |

Preset reference: [Agentonic preset](https://ui.shadcn.com/create?preset=b1GfVg2Oe). The [official CLI documentation](https://ui.shadcn.com/docs/cli) describes initialization and preset inspection. Preserve the generated token values except the explicit owner radius override: use `--radius: 0.625rem`, matching the [default shadcn radius](https://ui.shadcn.com/docs/theming), and retain the generated derived radius scale. The preset ID still encodes the original large radius; reinitializing it must reapply this override. Initialize within the planned monorepo layout, with shared primitives and theme; do not accidentally create a third app at the repository root. Pin the resulting dependencies in the workspace lockfile.

Retain the source contract's **Base UI** component architecture. The decoded preset does not identify a primitive library: explicitly select Base UI during initialization (the CLI supports `--base base`) and verify the generated configuration. Compose with `render`, using Base UI's actual open-state hooks (`data-popup-open` / `data-open` as applicable). A `Button` rendered as a Next.js `Link` sets `nativeButton={false}`. A `Select` with machine-readable values supplies a value-to-label `items` mapping so the trigger displays a human label.

Use shadcn components wherever an appropriate primitive exists, including buttons, fields, menus, dialogs, tables, empty states and tabs. Styling uses semantic tokens; no scattered palette classes. The new preset replaces Acachuchazo's Lyra geometry and green primary. Preserve its deliberate pill-shaped status badges, centralized status palette, blue underlined ID links and limited `text-highlight` token. The highlight remains a violet semantic token, used for at most one key value per card, never for status or a background surface; check its contrast against the new theme. Centralize these exceptions in shared components/tokens.

Shared label maps, variants and formatting helpers live in modules without `"use client"`; server components must not import non-component values from client modules. Both apps consume a shared UI package, while navigation, customer/staff actions and server authorization remain app-specific.

Carry over the source's Spanish (`es-VE`) interface and centralized `Intl` formatting as the initial language convention. All visible labels, pagination, errors and notifications use it consistently. Display operational times with an explicit applicable user/workspace timezone; do not inherit Acachuchazo's business timezone. Capitalize the word following separators such as `·` in metadata lines.

### 21.2. Page anatomy and navigation

Collection pages render a shared `PageHeader`: bold `text-3xl` title, formatted count appended as `Título: 1.811`, one-line muted description and right-aligned page actions. Optional statistics and filters precede the main content. Do not invent counts before data exists.

Each app has one typed navigation registry providing its sidebar, breadcrumb and page-header labels. Share the registry contract and rendering helpers, not staff navigation entries with customers. Unbuilt sections appear disabled with a `Pronto` badge. Keep routes, labels and permissions explicit.

### 21.3. Tables

Use pinned TanStack Table v8 and a shared `DataTable` for entity tables. Prefer a table over a card grid for collections larger than about six records; this does not turn chat transcripts or prompt editors into tables.

- Every data column has a sortable `DataTableColumnHeader`. The row-action column has no meaningless sort control.
- Search sits above the table and covers common-sense entity fields with multi-term AND matching. Server-backed search, sorting and pagination must cover the authorized result set, not only the current browser page.
- Provide Spanish pagination, page-size selection, a sticky header in a bounded scroll area, and a shadcn `Empty` state.
- When an entity has a working detail route, its first column is an eight-character ID rendered by the shared blue underlined `IdLink`. Omit that column until the detail route exists.
- Statuses use pill badges with the source palette: `success`, `warning`, `error`, `orange`, `sky`, `violet`, `emerald`, `slate`, and the appropriate `inverse*` variants on colored surfaces. Light mode uses tinted surfaces/dark text; dark mode uses page-background surfaces/luminous text. Never use the solid primary `default` badge for statuses. Text communicates status as well as color.

### 21.4. Filters and row actions

Extra filters live in a shared `FiltersCard` titled `Filtros`, arranged in a responsive grid, with a `Limpiar` action resetting every filter. The page's table wrapper owns filter state.

Row actions use a final-column ellipsis menu with icons. Destructive actions are red, separated at the bottom, and consequential operations require an `AlertDialog` with explicit title, consequence and confirmation label. A disabled or hidden control does not replace server-side authorization.

### 21.5. Forms and feedback

Forms use react-hook-form, Zod, `zodResolver`, `mode: "onChange"`, and shadcn `Field`, `FieldLabel`, and `FieldError`. Submit is disabled while required inputs are invalid or submission is in progress: `disabled={!isValid || isSubmitting}`. Validate again on the server and preserve actionable field errors.

Use Sonner at the bottom right with centralized `notify` helpers and distinct success, warning and destructive styles. Components do not call `toast` directly. Every completed submission or row action produces exactly one notification, including failures; cancellation produces no success claim. Inline field errors complement that notification. Pending asynchronous work must be described as queued/submitted, not deployed or completed.

### 21.6. Loading states and verification

Every rendered page route has a `loading.tsx` matching its actual structure: header, back row, cards, toolbar and table column count as applicable. Shared skeleton primitives include `PageHeaderSkeleton`, `RecordHeaderSkeleton`, `BackRowSkeleton`, `FiltersCardSkeleton`, `TableSkeleton` and `StatCardsSkeleton`; chat and editor routes receive matching specialized skeletons.

Port the source's skeleton freshness audit concept to both apps. Fingerprint each route's page, colocated visual components and loading skeleton; include relevant shared visual dependencies so a shared component change cannot silently escape review. `pnpm skeletons:check` must fail for missing skeletons, stale manifests and unreviewed visual changes. After changing a skeleton or explicitly confirming unchanged geometry, `pnpm skeletons:update` records the reviewed baseline. Hash freshness supplements visual review; it does not prove visual equivalence.

Foundation CI runs typecheck, lint, applicable tests and the skeleton audit. Verify responsive layouts, keyboard navigation, focus, validation feedback and light/dark/system themes as UI work lands. **Do not run `pnpm build` or `next build` for verification unless the owner explicitly requests a full build.**

### 21.7. Shell and detail pages

Use shadcn `Sidebar` with `variant="inset"`, an Agentonic brand mark placeholder, centralized application name/version, grouped navigation and bottom user menu. The menu provides theme selection (`Claro`, `Oscuro`, `Sistema` through next-themes with the `class` attribute), account and sign-out when those features work. Dynamic breadcrumbs use the navigation registry and shorten UUID segments to eight characters. Customer workspace selection and staff context must remain visibly distinct.

Nested pages render a separate ghost `BackRow` with left arrow immediately above `RecordHeader`, linking one route level up. Wrap the pair in `space-y-3`. Header actions remain available for operations and cross-links. `RecordHeader` contains title, one muted metadata line, status badges and right-aligned actions; do not add an initials avatar there.

For ordinary detail pages, use a responsive `lg:grid-cols-3` grid: operational content spans two columns, reference data occupies the side track. Use stat tiles with muted uppercase labels and tabular numeric values, shadcn `Item`/`ItemSeparator` for record lists and definition rows with `Separator` for attributes. Related records reuse `IdLink`; statuses reuse the shared maps.

When an agent has independent facets, use tabs under its record header, such as configuration, knowledge, connections and activity, with counts where useful. Dense workflows can have dedicated pages. Preserve the shared shell, form, feedback and loading rules across the customer editor, upload journey and chat.

Acachuchazo's credit-line meter, financial layouts, KYC tabs and single-customer mock overlay are domain-specific examples, not Agentonic features. Apply the underlying composition rules to agents, submissions and deployments. Synthetic fixtures must be clearly identified and isolated from real workflows; never display fabricated deployment health or costs as live data. Agentonic logo/favicon and custom login composition remain implementation work; the approved preset supplies the initial theme.

### 21.8. Agentonic workflow clarity

The customer app must distinguish an editable draft, a frozen submission awaiting review and the currently deployed version. Clearly label staging previews, selected source scopes and requested capabilities. Customer actions create, personalize, preview and submit; staff actions review and deploy through the established approval boundary. Shared visual components do not collapse those responsibilities.

Keep chat access, configuration management, transcript access and knowledge sharing separate in the interface. Explain what is being shared before granting it. A connection's knowledge-import scope and live tool permissions are separate choices. Display unknown cost as unknown, and show deployment progress from observed status rather than treating a queued command as a successful release.



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

Submission requires explicit consent for staff to read this exact configuration and its requested knowledge metadata for seven days. The staff queue exposes only currently consented proposal metadata. Opening a review is an explicit POST action that creates or reuses an exact submission-scoped support grant; subsequent reads are audited against that grant. Direct staff table reads cannot reveal customer drafts or document contents. Each read/decision rechecks consent, grant expiry, active submitter authority, workspace, code availability and collection rights. Withdrawal immediately blocks further review. Feedback decisions are append-only, tied to the frozen configuration/access hashes and explicitly marked unevaluated. Rejected or withdrawn candidates require another saved/frozen revision before resubmission.

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

Tools and connections each show one explicitly labeled example to demonstrate the same detail-dialog and confirmed-removal interactions. Hiding/restoring these examples only affects the current view. Examples never enter the save payload, request permissions, connect an account or execute a tool. Their dialogs distinguish knowledge import from live tool permissions. The compact tables are configuration previews, not new searchable entity directories; on narrow screens the type label moves below the name and actions remain visible.

The matching loading skeleton now contains the five configuration cards, save bar and two-column preparation/review section (stacked on mobile). Browser checks covered adding a synthetic local skill, viewing it, canceling with focus restoration, confirmed removal back to the unchanged draft, the tool detail dialog, and confirmed connection-example removal. The synthetic skill was never persisted. Desktop and 390px mobile layouts were visually reviewed. Typecheck, lint and all 120 existing tests passed; no production build or migration was run.

**Visual refinement, same day:** following the owner's second reference, skills, tools and connections now use borderless shadcn Item lists integrated into their cards. Remove the nested table frame, shaded column header and column labels; retain a subtle top divider and separators between entries. Names and type badges sit together, descriptions sit below, and ellipsis actions remain right-aligned. Dialogs, confirmations and persistence behavior are unchanged. The loading skeleton reflects these integrated rows.

**Content width refinement, same day:** the customer agent detail page and its loading skeleton now share a centered, fluid container capped at `max-w-4xl` (56rem / 896px). The header, configuration cards, save bar and review sections align within that column. Mobile retains the shell's responsive gutters; other pages keep their existing width.

**Collection picker refinement, same day:** replace the concatenated-value multi-select with a stacked, labeled Base UI checkbox list. Each collection keeps a visible name and selected state, with subtle row separators, keyboard focus indicators, the selected-count badge and a clear-selection action. The twenty-collection limit disables only unselected options so selections can always be removed. This remains local draft editing until Save; requested permissions and server checks are unchanged. The knowledge-card skeleton now reflects checkbox rows. Browser verification confirmed multiple selections and the corresponding unsaved state.

**Review sequence refinement, same day:** preparation and review submission now sit under a shared title and explanation with explicit “Paso 1 · Congelar” and “Paso 2 · Enviar” labels. Their grid uses equal fractional rows and stretched items, so both cards take the taller card's natural content height in any state, including stacked mobile layouts, without a hard-coded height or clipped content. The empty submission state directs the customer to complete step one. The loading skeleton mirrors the section and step labels. Browser measurements with the full submission form present confirmed equal heights on desktop (487.75px each) and mobile (530.5px each).

**Prompt validation and review actions, same day:** “Preparar versión” now uses the short description “Congela el borrador guardado.” Both review forms stretch through their card bodies and anchor their submit buttons at the bottom; browser measurements confirmed identical desktop button Y coordinates. The system prompt requires at least 50 characters excluding whitespace before saving or freezing. A shared input contract validates the draft-save command, both server actions return the prompt validation message, and the editor shows a live count plus an accessible inline error and disables invalid saves. Read schemas stay permissive so new/empty and older short drafts remain editable; existing frozen versions are not rewritten. Browser checks rejected 49 characters and enabled saving at 50, then restored the original field without saving. Contract tests cover whitespace padding, the 50-character boundary, legacy reads and rejection at the command boundary.

## 28. Agent listing configuration overview — 2026-09-14

The customer agent list includes sortable columns for system-prompt readiness and character count, skills, requested knowledge collections, tools, connections, live version and active review versions, alongside ID, name, status and editing access. Counts describe the saved draft, never unsaved browser changes or the frozen submission. “Listas” means the prompt meets the 50-character minimum, not that its quality has been evaluated. Whitespace is excluded and Unicode code points are counted consistently by the editor and database. New agents without a stored draft show zero counts and incomplete instructions.

Migration `202609140006_agent_listing` adds the read-only `agentonic.agent_listing()` function, with customer-role-only execute privileges, verified transaction-local identity/workspace, active membership, compatible workspace read locks and per-agent authorization. One batch query returns metadata and counts without returning prompts, skill instructions or collection IDs. Configuration summaries are null for metadata-only collaborators; the UI shows “Sin acceso,” rather than misleading zero counts. The list page loads this overview alongside the existing workspace/template data without per-agent detail calls. No tables or DBML changes were needed; six migrations are now applied to nonproduction, retaining the 28 implemented tables.

Active review versions come from actual submissions in `submitted` or `in_review`, joined to their frozen release; all active entries are shown if more than one exists, and withdrawn/rejected/completed entries are excluded. Tools and connections currently have zero real assignments and are labeled “Próximamente.” Live version is explicitly absent (“Sin desplegar”) while deployment records remain unimplemented; no draft or code release is presented as deployed.

The shared shell now permits its content flex item to shrink, keeping the wide eleven-column table inside its own horizontal scroll area. The list skeleton includes the explanatory line and matching column count. Verification: 128 tests passed, including saved and empty counts, Unicode/whitespace handling, active/withdrawn submissions, workspace isolation and metadata-only access; Prisma generation/validation, typecheck and lint passed. The migration was applied using the dedicated migration role with verified remote TLS. Browser review confirmed the real nonproduction rows and contained horizontal overflow.

**Listing density refinement, same day:** prompt readiness now uses an accessible check/X icon badge beside the character count. Agent descriptions stay on one truncated line, with their full text in a Base UI tooltip on hover or keyboard focus. The two version columns are combined into “Versiones”: a deployment icon and version/empty state above review icons and actual submitted versions/statuses. The ten-column loading skeleton matches. Row actions now use an ellipsis menu with the working Edit link; costs/consumption, logs, stop and delete are visibly disabled under “Próximamente” because their backend workflows do not exist yet. No stop/delete request, fake success or live-runtime action is performed by these placeholders. Browser checks confirmed menu availability and the keyboard-accessible description tooltip.

## 29. Connected freeze/review prerequisites — 2026-09-14

The agent editor and its two workflow steps now share a single react-hook-form instance for the draft. Workflow buttons derive validity, dirty state and save-pending state directly from that form; opening a skill dialog also blocks the steps. The action handler checks the current form values again before making a request. Successful mutations keep controls disabled through the subsequent refresh. The customer can see a checklist of met/pending conditions in each card, while matching card heights and bottom-aligned buttons are preserved.

Step one requires a saved revision, valid system instructions and any supplied skills, no unsaved changes or open skill dialog, current access to every requested collection, and an available selected code release. It disables repeat freezing of the same draft revision/code pair. Step two additionally requires an eligible, unsent frozen candidate from the current saved revision, a valid optional note of at most 2000 characters, and explicit review consent. It no longer silently offers older candidates after a new draft revision is saved. Skills and knowledge collections remain optional; unimplemented preview/evaluation features are not invented as prerequisites.

The server enriches candidate detail with code-release identity and submission eligibility using the existing detail transaction's verified identity, RLS and workspace read lock. Retired candidates, unavailable code, revoked snapshot-collection access, already-submitted candidates and invalid frozen instructions cannot be offered as eligible. The customer receives eligibility metadata, not additional snapshot content. Freeze validates the full saved draft, while submission checks candidate ownership, current revision and eligibility before invoking the existing database command; database authorization, consent, uniqueness, code and collection checks remain the final authority. These checks use existing read grants and require no migration or broader privileges.

The specialized freeze/review forms use Zod and react-hook-form, including controlled consent and candidate selection. Missing candidates leave the review button and its dependent controls disabled. Failed requests retain form fields and show one error notification. The loading skeleton now mirrors the two requirement lists. Verification: 138 tests passed, including missing/invalid/unsaved drafts, open skill editing, consent, note limits, unavailable code/collections, duplicate freeze, stale/already-submitted candidates and pending operations. Browser checks confirmed live unsaved/invalid/open-dialog gating, restoration to the original saved values without persisting test changes, aligned action buttons and a clean console. No version was frozen or submitted during browser verification.
