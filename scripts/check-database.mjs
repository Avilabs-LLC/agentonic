import assert from "node:assert/strict"
import pg from "pg"
import { loadLocal, pgConfig, fail } from "./local-config.mjs"
try {
  const e = loadLocal(".env.database.local")
  for (const role of ["admin", "customer"]) {
    const pool = new pg.Pool(
      pgConfig(
        e[`AGENTONIC_${role.toUpperCase()}_DATABASE_URL`],
        e.AGENTONIC_DATABASE_CA_FILE,
        { max: 2 }
      )
    )
    try {
      const r = await pool.query(
        "SELECT current_user,rolsuper,rolbypassrls,rolcreaterole FROM pg_roles WHERE rolname=current_user"
      )
      assert.equal(r.rows[0].current_user, "agentonic_" + role)
      assert.equal(r.rows[0].rolsuper, false)
      assert.equal(r.rows[0].rolbypassrls, false)
      assert.equal(r.rows[0].rolcreaterole, false)
      const owner = await pool.query(
        "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='agentonic' AND tableowner=current_user"
      )
      assert.equal(owner.rows[0].count, 0)
      const inherited = await pool.query(
        "SELECT pg_has_role(current_user,'agentonic_migrator','MEMBER') AS can_migrate"
      )
      assert.equal(inherited.rows[0].can_migrate, false)
      for (const table of [
        "users",
        "platform_staff",
        "workspaces",
        "workspace_members",
        "workspace_invitations",
        "support_access_grants",
        "contacts",
        "agent_contact_grants",
        "code_repositories",
        "agent_templates",
        "template_versions",
        "agents",
        "agent_member_grants",
        "knowledge_collections",
        "collection_member_grants",
        "audit_events",
        "code_releases",
        "workspace_code_release_grants",
        "code_tools",
        "configuration_drafts",
        "configuration_releases",
        "configuration_tools",
        "agent_submissions",
        "submission_review_decisions",
        "stored_objects",
        "knowledge_sources",
        "documents",
        "document_versions",
      ]) {
        assert.equal(
          (await pool.query(`SELECT * FROM agentonic.${table}`)).rowCount,
          0
        )
        const rls = await pool.query(
          "SELECT relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='agentonic' AND relname=$1",
          [table]
        )
        assert.equal(rls.rows[0].relrowsecurity, true)
      }
      for (const table of [
        "retrieval_profile",
        "document_chunks",
        "background_jobs",
        "ingestion_jobs",
        "retrieval_provider_budgets",
        "retrieval_provider_operations",
      ]) {
        await assert.rejects(pool.query(`SELECT * FROM agentonic.${table}`), {
          code: "42501",
        })
        const rls = await pool.query(
          "SELECT relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='agentonic' AND relname=$1",
          [table]
        )
        assert.equal(rls.rows[0].relrowsecurity, true)
      }
      await assert.rejects(
        pool.query("UPDATE agentonic.workspaces SET name='denied' WHERE false"),
        { code: "42501" }
      )
      await assert.rejects(
        pool.query("SELECT agentonic_bootstrap.link_auth_users()"),
        { code: "42501" }
      )
      const actors = [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ]
      await Promise.all(
        actors.map(async (actor) => {
          const c = await pool.connect()
          try {
            await c.query("BEGIN READ ONLY")
            await c.query(
              "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id','',true),set_config('agentonic.verified_email','synthetic@example.invalid',true)",
              [actor]
            )
            assert.equal(
              (
                await c.query(
                  "SELECT current_setting('agentonic.auth_user_id') AS actor"
                )
              ).rows[0].actor,
              actor
            )
            await c.query("COMMIT")
            assert.equal(
              (
                await c.query(
                  "SELECT nullif(current_setting('agentonic.auth_user_id',true),'') AS actor"
                )
              ).rows[0].actor,
              null
            )
          } finally {
            await c.query("ROLLBACK")
            c.release()
          }
        })
      )
      await assert.rejects(
        pool.query("SELECT agentonic.assert_owners(gen_random_uuid())"),
        { code: "42501" }
      )
      await assert.rejects(
        pool.query(
          "SELECT agentonic.can_contact_invoke(gen_random_uuid(),gen_random_uuid())"
        ),
        { code: "42501" }
      )
      // Reuse the same pooled connections after both committed transactions.
      for (let i = 0; i < 4; i++)
        assert.equal(
          (
            await pool.query(
              "SELECT nullif(current_setting('agentonic.auth_user_id',true),'') AS actor"
            )
          ).rows[0].actor,
          null
        )
      console.log(
        `${role}: verified TLS, restricted role, RLS, denied writes, concurrent identity and clean pool reuse passed.`
      )
    } finally {
      await pool.end()
    }
  }
  const worker = new pg.Pool(
    pgConfig(e.AGENTONIC_WORKER_DATABASE_URL, e.AGENTONIC_DATABASE_CA_FILE)
  )
  try {
    await assert.rejects(worker.query("SELECT * FROM agentonic.workspaces"), {
      code: "42501",
    })
    for (const table of [
      "document_chunks",
      "background_jobs",
      "retrieval_provider_operations",
    ])
      await assert.rejects(worker.query(`SELECT * FROM agentonic.${table}`), {
        code: "42501",
      })
    console.log(
      "worker: no direct application data access; leased functions only."
    )
  } finally {
    await worker.end()
  }
} catch (error) {
  fail(error)
}
