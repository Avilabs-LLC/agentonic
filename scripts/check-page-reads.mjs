import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { performance } from "node:perf_hooks"
import { bootstrapConfig, loadLocal, connect, fail } from "./local-config.mjs"
// Opt-in nonproduction probe. Every audit/test write is rolled back; no Auth changes.
try {
  const { e } = bootstrapConfig(),
    env = loadLocal(".env.database.local")
  const lookup = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  let actor
  try {
    actor = (
      await lookup.query(
        "SELECT u.auth_user_id auth_id,w.id workspace_id FROM agentonic.users u JOIN agentonic.workspace_members m ON m.user_id=u.id JOIN agentonic.workspaces w ON w.id=m.workspace_id WHERE w.slug='bootstrap-customer-a' AND m.role='owner' AND m.status='active' AND m.removed_at IS NULL AND u.deleted_at IS NULL"
      )
    ).rows[0]
    assert.ok(actor)
  } finally {
    await lookup.end()
  }
  for (const role of ["customer", "admin"]) {
    const clients = []
    try {
      for (let i = 0; i < 2; i++) {
        const c = await connect(
          env[`AGENTONIC_${role.toUpperCase()}_DATABASE_URL`],
          env.AGENTONIC_DATABASE_CA_FILE
        )
        clients.push(c)
        await c.query("BEGIN")
        await c.query(
          "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id',$2,true)",
          [actor.auth_id, actor.workspace_id]
        )
        await c.query("SET LOCAL lock_timeout='500ms'")
      }
      const [first, second] = clients
      const start = performance.now()
      const identity = (
        await first.query("SELECT agentonic.identity_overview() overview")
      ).rows[0].overview
      const identityRoundTripMs = Math.round(performance.now() - start)
      assert.equal(
        identity.workspaces.some((w) => w.id === actor.workspace_id),
        true
      )
      const explain = (
        await first.query(
          "EXPLAIN (ANALYZE,FORMAT JSON) SELECT agentonic.identity_overview()"
        )
      ).rows[0]["QUERY PLAN"][0]
      const read = async (c) => {
        const result = await c.query(
          "SELECT agentonic.authoring_command('list','{}'::jsonb,$1::uuid) result",
          [randomUUID()]
        )
        assert.equal(result.rows[0].result.ok, true)
      }
      await read(first) // Retains the workspace lock until rollback below.
      await read(second) // Must coexist, not wait for the first transaction.
      await second.query("SAVEPOINT writer_check")
      await assert.rejects(
        second.query(
          "SELECT agentonic.access_command('collection.create',$1::jsonb,$2::uuid)",
          [
            JSON.stringify({
              name: "Rollback-only lock probe",
              slug: `probe-${randomUUID()}`,
            }),
            randomUUID(),
          ]
        ),
        { code: "55P03" }
      )
      await second.query("ROLLBACK TO SAVEPOINT writer_check")
      console.log(
        `${role}: identity round trip ${identityRoundTripMs} ms; database execution ${explain["Execution Time"]} ms; concurrent readers passed; conflicting writer waits; all test writes rolled back.`
      )
    } finally {
      for (const c of clients) {
        await c.query("ROLLBACK")
        await c.end()
      }
    }
  }
} catch (error) {
  fail(error)
}
