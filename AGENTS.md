# Agentonic

Read `docs/agentonic-architecture.md` for accepted architecture and the stepwise implementation plan. Read `docs/ui/ui-contract.md` before any UI work; it is the authoritative presentation contract for both apps. `docs/schema.dbml` is the full target; only checked-in Prisma migrations describe implemented slices.

- Admin and customer are separate Next.js apps. Share UI and services; never trust a client-supplied user, staff role or workspace as authorization.
- Supabase owns Auth and Storage. Prisma is the only application migration authority, including reviewed SQL policies/triggers.
- Use restricted database roles and transaction-local verified identity/workspace context. Bootstrap/migration secrets never enter application environments or client code.
- Keep real credentials, account emails, documents and generated test credentials out of Git and logs.
- Shared UI follows Base UI composition and shadcn preset `b1GfVg2Oe`. Badges express primary record states; nested outcomes use unboxed icons/text, and metadata/counts use plain text. Use shared domain status descriptors. Pages require matching loading states and reviewed skeleton baselines.
- User-facing copy is Spanish (`es-VE`). No fake live health, costs or success actions.
- Executable previews must pin reviewed code and frozen configuration hashes. Preserve accumulated provider usage and reservations across setup, tests and deployment.
- Never change live Corby or VM services incidentally. Azure hosting uses systemd and fixed release directories.
- Do not spawn subagents unless the user asks.

## Verification

Run `pnpm db:generate`, `pnpm db:validate`, `pnpm typecheck`, `pnpm lint`, `pnpm test` and `pnpm skeletons:check` for relevant changes. Review skeletons before `pnpm skeletons:update`.

**Do not run `pnpm build` or `next build` unless the user explicitly requests a full build.** These rewrite `.next` and can corrupt a running development server. Use `pnpm typecheck` / `tsc --noEmit` and `pnpm lint` / ESLint instead.

Migrations and bootstrap scripts target the explicitly configured nonproduction project. Never edit applied migrations or use `db push`, migration resets or real customer content as test fixtures. Keep SQL-only protections in reviewed migrations and deterministic tests.
