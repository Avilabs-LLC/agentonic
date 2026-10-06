# Agentonic

Platform monorepo for the staff admin app, customer app, platform workers and the agent runtime (`packages/runtime`). The runtime is packaged as an immutable, content-addressed artifact that runs the agent loop in a credential-free child process; the worker broker holds credentials and executes provider and tool calls (architecture §40). Releases up to 0.3.0 came from the frozen `Avilabs-LLC/agentonic-runtime` repository.

**Start with [docs/current-state.md](docs/current-state.md)**: a short summary of what runs where, what works end to end and what isn't built yet. Open work, who acts next and when each item counts as done are in [docs/outstanding-actions.md](docs/outstanding-actions.md). The authoritative design and dated implementation checkpoints are in [docs/agentonic-architecture.md](docs/agentonic-architecture.md) (§§22–52), and presentation rules are in [docs/ui/ui-contract.md](docs/ui/ui-contract.md). [docs/schema.dbml](docs/schema.dbml) describes the complete target model; 62 of its 79 tables exist so far. Everything runs against one nonproduction Supabase project: customers can author, preview, submit, get approval and chat with a privately activated agent, but nothing is hosted for outside users yet.

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

### Mobile testing through a development tunnel

Forward the customer app's port 3101 through an authenticated HTTPS tunnel. Set
`AGENTONIC_CUSTOMER_DEV_ORIGIN=https://YOUR-TUNNEL-3101.REGION.devtunnels.ms` in
`apps/customer/.env.local`, then restart the customer dev server. Open that HTTPS
URL on the phone, pass the tunnel's sign-in, and sign into Agentonic. Keep the Mac
and its preview worker running when testing agents.

This development-only setting permits the exact tunnel hostname for Next.js dev
assets and Server Actions, plus the `localhost:3101` / `127.0.0.1:3101` origins
that Dev Tunnels may forward. It does not trust wildcard tunnel domains, change
production origin checks, expose the loopback listener to the LAN, or grant app
access. Update the setting when the tunnel URL changes. Existing Gmail connections
can be used; connecting a new Gmail account on mobile additionally requires the
same tunnel callback URL in `GOOGLE_REDIRECT_URI` and Google's authorized redirect
URIs. A localhost callback returns to the phone, not this Mac.

Both apps use the same Base UI/shadcn Mira preset (`b1GfVg2Oe`), Figtree font and shared UI package. Authentication cookies are separate per app, host-only and HTTP-only. Customer membership never grants staff access.

The configured nonproduction Supabase project has its dedicated roles and every checked-in migration applied. The three confirmed Auth users are linked: one staff administrator and two customer owners, each with a separate test workspace. Their actual access boundaries have been verified; interactive sign-in uses the private passwords chosen in Supabase. App `.env.local` files contain only their restricted database credentials and public Supabase configuration. No bootstrap or migration URL belongs in either app's environment.

For a fresh authorized nonproduction setup, fill `.env.bootstrap.local` from its example, provide the verified Supabase CA, and run:

```sh
pnpm setup:database
pnpm setup:storage
pnpm db:migrate
pnpm setup:accounts
pnpm setup:template
```

Create the private `agentonic-documents` Storage bucket (10 MB maximum) before migration. The authoring-template command publishes the original `v0.1.0-authoring` template; it still requires the clean adjacent `agentonic-runtime` checkout at that tag and GitHub CLI read access to its private release. Executable runtimes now come from `packages/runtime` (see "Local frozen-version preview" below).

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
apps/worker/            Knowledge processing, previews, evaluator, staging controller and broker
packages/runtime/       Credential-free agent runtime (packaged as frozen artifacts)
packages/connectors/    Provider clients (Google, Browserbase)
packages/ui/            Shared preset, primitives, forms, tables and shell
packages/contracts/     Validation, formatting and domain contracts
packages/server/        Server-only authentication and application access
packages/database/      Prisma model, generated client and SQL migrations
scripts/                Explicit setup, packaging, staging operations and verification
```

App roles are non-owner and non-BYPASSRLS. Tables remain SELECT-only; validated command functions handle authorized writes and audit them atomically. Tenant queries require a verified actor, transaction-local workspace and current resource authority as well as active membership. A restricted discovery function returns only the caller's active workspace IDs. The restricted worker uses leased command functions for knowledge and private previews.

## Staging on `vm-agents-01`

The Azure VM runs the evaluator, the staging deployment controller and one database gateway as systemd services from fixed, content-addressed release directories; activated agents rest while idle (architecture §§36, 40–41, 43). The web apps and the knowledge worker still run only on the Mac. Hosts and evaluators stay trusted for seven days; the Mac renews them by re-measuring the installation, never by rebuilding:

```sh
pnpm staging:reverify            # read-only: expiry, releases and service health
pnpm staging:reverify --verify   # run every check, change nothing
pnpm staging:reverify --renew    # re-verify and renew what expires within 2 days
```

`--schedule` installs the twice-daily launchd job (with `--publish`, which feeds the GitHub alert workflow). `pnpm staging:restart-window` manages the Sunday restart window. Runtimes install side by side with `pnpm runtime:install`; new worker releases install next to running ones with `install-staging`. Never change the VM or live Corby incidentally. See [docs/current-state.md](docs/current-state.md) for alerts, backups and the rebuild procedure.

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

Submitted versions are evaluated on the VM against criteria the customer confirms, then approved automatically (routine versions) or by staff (versions with tools). Admin `/submissions` shows consented proposals, receipts and the approval, renewal and activation controls; staff may return comments, request changes or reject. Admin `/expirations` lists what expires, when and who must act. After approval, the customer authorizes private staging use (up to seven days and US$1), staff activate it, and the customer chats with it in `/chats`. Production deployment remains unavailable.

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

After committing reviewed changes to `packages/runtime`, run `pnpm setup:preview` to package and register its exact executable artifact for the configured nonproduction workspaces, then `pnpm runtime:install --local|--azure --runtime-sha256=<hash>` to install it next to the runtimes already on that host and evaluator. Select that code release when freezing a new candidate, then open **Probar versión** from the agent. Existing candidates keep their original code. `pnpm dev` starts the apps and broker; do not start a duplicate worker.

Previews are private, last ten minutes, accept ten messages and cap spending at US$0.25 within the accumulated Voyage/OpenAI development allowances. They use frozen instructions/skills and authorized staging sources; tools and production actions remain disabled. `pnpm preview:check-live` makes paid synthetic calls and is excluded from routine CI. Its `--keep-fixture` option retains a labeled synthetic agent for browser QA; `node scripts/check-preview-live.mjs --cleanup` removes it while preserving usage. The architecture records VM staging, recovery and production gates still pending.
