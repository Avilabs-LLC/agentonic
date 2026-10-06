import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { bootstrapConfig, connect, fail } from "./local-config.mjs"
// Installs the public wrapper for the invite-only sign-up hook (architecture
// §54), then checks who may run it and that it refuses an uninvited address.
// Afterwards, select public.agentonic_before_user_created in Supabase:
// Authentication > Hooks > Before User Created > Postgres.
let client
try {
  const { e, ref } = bootstrapConfig()
  assert.equal(ref, "jkgdxkacariasunhentd")
  client = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  await client.query("BEGIN")
  await client.query(
    readFileSync(new URL("./sql/auth-hook.sql", import.meta.url), "utf8")
  )
  const access = await client.query(
    `SELECT role, has_function_privilege(role, 'public.agentonic_before_user_created(jsonb)', 'EXECUTE') allowed
     FROM unnest(ARRAY['supabase_auth_admin','anon','authenticated','service_role','agentonic_customer']) role`
  )
  const allowed = access.rows
    .filter((row) => row.allowed)
    .map((row) => row.role)
  assert.deepEqual(
    allowed,
    ["supabase_auth_admin"],
    "Only Supabase Auth may run the hook"
  )
  // The bootstrap role cannot become Supabase's Auth role; it calls the
  // wrapper as its owner to check the rule itself.
  const probe = await client.query(
    "SELECT public.agentonic_before_user_created($1::jsonb) result",
    [JSON.stringify({ user: { email: "sin-invitacion@agentonic.invalid" } })]
  )
  assert.equal(probe.rows[0].result?.error?.http_code, 403)
  await client.query("COMMIT")
  console.log(
    "Sign-up hook installed: only Supabase Auth may run public.agentonic_before_user_created, and it refuses an uninvited address. Select it in Authentication > Hooks > Before User Created."
  )
} catch (error) {
  await client?.query("ROLLBACK")
  fail(error)
} finally {
  await client?.end()
}
