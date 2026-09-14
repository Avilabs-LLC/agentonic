# Agentonic

Platform monorepo for the staff admin app, customer app and platform workers. Agent execution code belongs in the separate `Avilabs-LLC/agentonic-runtime` repository.

The authoritative design is in [docs/agentonic-architecture.md](docs/agentonic-architecture.md), including the UI contract (§21) and implementation status (§§22–29). [docs/schema.dbml](docs/schema.dbml) describes the complete target model. Twenty-eight tables support identity/access, customer authoring, private uploads and consented staff review. Paid preview, ingestion, approval and deployment remain unavailable.

## Local development

Use Node.js 22 (22.12 or newer) and pnpm 11.21.0.

```sh
pnpm install --frozen-lockfile
pnpm db:generate
pnpm dev
```

- Admin: <http://127.0.0.1:3100>
- Customer: <http://127.0.0.1:3101>

Local dev commands allow up to 64 KiB of request headers, because browsers share host-only cookies across every `localhost` port. This avoids HTTP 431 when other local apps leave large session cookies. The setting applies only to the loopback development servers; production startup is unchanged.

Both apps use the same Base UI/shadcn Mira preset (`b1GfVg2Oe`), Figtree font and shared UI package. Authentication cookies are separate per app, host-only and HTTP-only. Customer membership never grants staff access.

The local bootstrap has already provisioned dedicated roles and applied the first six migrations to the configured nonproduction Supabase project. The three confirmed Auth users are now linked: one staff administrator and two customer owners, each with a separate test workspace. Their actual access boundaries have been verified; interactive sign-in uses the private passwords chosen in Supabase. App `.env.local` files contain only their restricted database credentials and public Supabase configuration. No bootstrap or migration URL belongs in either app's environment.

For a fresh authorized nonproduction setup, fill `.env.bootstrap.local` from its example, provide the verified Supabase CA, and run:

```sh
pnpm setup:database
pnpm setup:storage
pnpm db:migrate
pnpm setup:accounts
pnpm setup:template
```

Create the private `agentonic-documents` Storage bucket (10 MB maximum) before migration. The authoring-template command also requires the clean adjacent runtime checkout at the published authoring tag and GitHub CLI read access to its private release.

These are explicit remote setup commands. `setup:accounts` only links the three configured, already-confirmed Supabase Auth users. It sends no emails and creates no Auth users. It creates two clearly named nonproduction workspaces with finite test retention and a separate staff role; it does not grant staff customer membership. Keep passwords private and create/confirm the Auth users in the Supabase dashboard before running it. Re-running does not restore disabled staff or overwrite an existing workspace's owner.

Supabase's Auth schema does not permit delegating its grants from the ordinary `postgres` role. The bootstrap therefore creates one narrowly scoped, migration-only `agentonic_bootstrap.link_auth_users()` function to add the external FK. It accepts no arguments and exposes no Auth data. Prisma still owns the application migration history.

On macOS, Prisma's native migration TLS backend rejects the Supabase CA despite node-pg verifying it correctly. `db:migrate` uses a temporary loopback PostgreSQL bridge: all traffic to Supabase is encrypted with CA and hostname verification. The local child-process connection is unencrypted on `127.0.0.1` only; no network listener is exposed. The bridge ends after Prisma exits. Do not remove remote certificate verification or add a global trust exception.

## Verification

```sh
pnpm db:validate
pnpm typecheck
pnpm lint
pnpm test
pnpm skeletons:check
```

Tests use disposable synthetic data. Hosted checks are opt-in, use the restricted local credentials, and make no data changes:

```sh
pnpm db:check
pnpm db:check-prisma
```

Every page has a matching loading skeleton. After reviewing any affected visual sources and loading states, run `pnpm skeletons:update` to record the review baseline. CI checks the manifest and shared visual dependencies.

**Do not run `pnpm build` or `next build` for verification.** They rewrite `.next` and can corrupt running development servers. A deliberate deployment build requires explicit owner authorization.

## Layout

```text
apps/admin/             Staff Next.js app
apps/customer/          Customer Next.js app
apps/worker/            Knowledge processing and private preview broker
packages/ui/            Shared preset, primitives, forms, tables and shell
packages/contracts/     Validation, formatting and domain contracts
packages/server/        Server-only authentication and application access
packages/database/      Prisma model, generated client and SQL migrations
scripts/                Explicit setup, verification and skeleton tooling
```

App roles are non-owner and non-BYPASSRLS. Tables remain SELECT-only; validated command functions handle authorized writes and audit them atomically. Tenant queries require a verified actor, transaction-local workspace and current resource authority as well as active membership. A restricted discovery function returns only the caller's active workspace IDs. The restricted worker uses leased command functions for knowledge and private previews.

The VM has been inspected only. No Azure packages, services, firewall rules or deployment files have been installed. Future releases use systemd and fixed release directories as described in the architecture.

## Identity and resource access services

`packages/server/src/access.ts` is the server-only entry point for workspace membership, draft-agent creation, explicit agent/collection sharing, contacts, scoped staff support and invitation services. It derives identity and confirmed email from Supabase, validates strict contracts and invokes the database's fixed-operation permission boundary. It is not a public API route or an invitation-delivery service. Agent authoring and collections now have customer screens; invitation, member-sharing and contact management screens follow their feature milestones.

The real private `v0.1.0-authoring` runtime artifact is registered for the two test workspaces. It supports configuration authoring only and refuses execution. Collection permissions are independent of agent permissions. Only resource owners can delegate private content access; staff must use exact, expiring support grants and audited reads. Customers cannot publish or deploy.

To verify the actual configured test accounts and permission commands:

```sh
pnpm db:check-access
pnpm db:check-authoring
```

This explicit nonproduction check temporarily exercises resource creation, invitation acceptance, sharing, support reads and offboarding through restricted app credentials. Deferred constraints are forced before rollback so commit-time ownership checks are tested. All test transactions are rolled back, including their audit events. It sends no emails, changes no Auth users and prints no account addresses or credentials. The bootstrap credential is used only for read-only lookup of the configured test identities.

## Customer authoring and staff review

Customer `/agents` supports creation, revisioned prompts/skills, exact candidate freezing, consented submission and feedback history. `/knowledge` supports private PDF/text/Markdown uploads, up to 10 MB each. Documents are processed locally; removal immediately removes derived knowledge and queues physical cleanup. A 500 MB workspace inventory ceiling includes retained and failed reservations.

Admin `/submissions` exposes consented proposals and audited configuration review. Staff may return comments, request changes or reject. Private frozen-version previews are available locally; production approval and deployment remain unavailable.

OpenAI is selected for the next execution milestone, with an authorized **US$25 total development cap**. Store the key in ignored `apps/worker/.env.local` as `OPENAI_API_KEY`. The worker uses its ignored environment file and reserves paid calls against the shared accumulated ledger. See architecture §§30–31 for the implemented boundary.

## Releases

The root package version identifies the platform release; private workspace package versions are not independently published. Before the release commit, run:

```sh
node scripts/versioning.mjs bump branch --summary "Describe the completed milestone"
pnpm version:check
```

This increments the minor version and resets the patch, recording the release in `lib/app-version.ts` and `lib/version-history.ts` and updating the shared UI label. Review that label and refresh the skeleton baseline with `pnpm skeletons:update` before committing. CI verifies that the package, application, history and UI versions agree. This command does not build or deploy either app.

For an authorized release directly on `main`, use `node scripts/versioning.mjs bump direct --summary "Describe the completed changes"` instead. It increments only the patch version and updates the same metadata; run the same version and skeleton checks before committing and pushing.

`pnpm db:check-page-reads` is an opt-in nonproduction concurrency check for both restricted app roles. It checks actor-scoped identity discovery, concurrent readers and conflicting writers; all temporary writes are rolled back. Page-load observations and limitations are recorded in architecture section 25.

## Local frozen-version preview

After reviewing and committing the sibling runtime checkout, run `pnpm setup:preview` to package and register its exact executable artifact for the configured nonproduction workspaces. Select that code release when freezing a new candidate, then open **Probar versión** from the agent. Existing candidates keep their original code. `pnpm dev` starts the apps and broker; do not start a duplicate worker.

Previews are private, last ten minutes, accept ten messages and cap spending at US$0.25 within the accumulated Voyage/OpenAI development allowances. They use frozen instructions/skills and authorized staging sources; tools and production actions remain disabled. `pnpm preview:check-live` makes paid synthetic calls and is excluded from routine CI. Its `--keep-fixture` option retains a labeled synthetic agent for browser QA; `node scripts/check-preview-live.mjs --cleanup` removes it while preserving usage. The architecture records VM staging, recovery and production gates still pending.
