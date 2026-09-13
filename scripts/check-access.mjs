import assert from "node:assert/strict"
import { randomUUID, randomBytes, createHash } from "node:crypto"
import { bootstrapConfig, loadLocal, connect, fail } from "./local-config.mjs"

// Explicit nonproduction integration check. All test commands and their audit
// records run in transactions that are ALWAYS rolled back. No emails are sent.
try {
  const { e } = bootstrapConfig()
  const urls = loadLocal(".env.database.local")
  const lookup = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  let a, b, staff
  try {
    const findOwner = async (email, slug) => {
      const r = await lookup.query(
        `SELECT u.auth_user_id AS auth_id,w.id AS workspace_id,m.id AS member_id
        FROM agentonic.users u JOIN auth.users au ON au.id=u.auth_user_id
        JOIN agentonic.workspace_members m ON m.user_id=u.id JOIN agentonic.workspaces w ON w.id=m.workspace_id
        WHERE lower(au.email)=lower($1) AND au.email_confirmed_at IS NOT NULL AND u.deleted_at IS NULL
        AND w.slug=$2 AND m.role='owner' AND m.status='active' AND m.removed_at IS NULL`,
        [email, slug]
      )
      assert.equal(r.rowCount, 1)
      return r.rows[0]
    }
    a = await findOwner(
      e.AGENTONIC_BOOTSTRAP_CUSTOMER_A_OWNER_EMAIL,
      "bootstrap-customer-a"
    )
    b = await findOwner(
      e.AGENTONIC_BOOTSTRAP_CUSTOMER_B_OWNER_EMAIL,
      "bootstrap-customer-b"
    )
    const r = await lookup.query(
      `SELECT s.id,u.auth_user_id AS auth_id FROM agentonic.platform_staff s
      JOIN agentonic.users u ON u.id=s.user_id JOIN auth.users au ON au.id=u.auth_user_id
      WHERE lower(au.email)=lower($1) AND s.disabled_at IS NULL AND u.deleted_at IS NULL`,
      [e.AGENTONIC_BOOTSTRAP_STAFF_EMAIL]
    )
    assert.equal(r.rowCount, 1)
    staff = r.rows[0]
  } finally {
    await lookup.end()
  }
  for (const role of ["customer", "admin"]) {
    const client = await connect(
      urls[`AGENTONIC_${role.toUpperCase()}_DATABASE_URL`],
      urls.AGENTONIC_DATABASE_CA_FILE
    )
    let collectionId
    try {
      await client.query("BEGIN")
      const actor = async (authId, workspace = a.workspace_id, email = "") => {
        await client.query(
          "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id',$2,true),set_config('agentonic.verified_email',$3,true)",
          [authId, workspace, email]
        )
      }
      const command = async (operation, payload = {}) =>
        (
          await client.query(
            "SELECT agentonic.access_command($1,$2::jsonb,$3::uuid) AS result",
            [operation, JSON.stringify(payload), randomUUID()]
          )
        ).rows[0].result
      const denied = async (operation, payload) => {
        await client.query("SAVEPOINT expect_denial")
        try {
          assert.equal((await command(operation, payload)).ok, false)
        } catch (error) {
          if (error.code !== "42501") throw error
        } finally {
          await client.query(
            "ROLLBACK TO SAVEPOINT expect_denial; RELEASE SAVEPOINT expect_denial"
          )
        }
      }
      await actor(a.auth_id)
      const created = await command("collection.create", {
        name: "Temporary permission verification",
        slug: `verification-${randomUUID()}`,
      })
      assert.equal(created.ok, true)
      collectionId = created.id
      const grant = await command("support.approve", {
        staffId: staff.id,
        reason: "Temporary permission verification",
        scope: {
          version: 1,
          resources: [
            { type: "collection", id: collectionId, operations: ["read"] },
          ],
        },
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      })
      assert.equal(grant.ok, true)
      await actor(b.auth_id, b.workspace_id)
      assert.equal(
        (
          await client.query(
            "SELECT * FROM agentonic.knowledge_collections WHERE id=$1",
            [collectionId]
          )
        ).rowCount,
        0
      )
      await actor(staff.auth_id)
      assert.equal(
        (
          await client.query(
            "SELECT * FROM agentonic.knowledge_collections WHERE id=$1",
            [collectionId]
          )
        ).rowCount,
        0
      )
      const read = {
        grantId: grant.id,
        resourceType: "collection",
        resourceId: collectionId,
      }
      if (role === "admin")
        assert.equal((await command("support.read", read)).ok, true)
      else await denied("support.read", read)
      await actor(a.auth_id)
      assert.equal(
        (await command("support.revoke", { grantId: grant.id })).ok,
        true
      )
      await actor(staff.auth_id)
      await denied("support.read", read)
      await actor(a.auth_id)
      await denied("agent.deploy", {})
      await denied("member.update", {
        memberId: a.member_id,
        role: "member",
        status: "removed",
      })
      if (role === "customer") {
        const tokenHash = createHash("sha256")
          .update(randomBytes(32))
          .digest("hex")
        assert.equal(
          (
            await command("invite.issue", {
              email: e.AGENTONIC_BOOTSTRAP_CUSTOMER_B_OWNER_EMAIL,
              role: "member",
              tokenHash,
              expiresAt: new Date(Date.now() + 600_000).toISOString(),
            })
          ).ok,
          true
        )
        await actor(
          b.auth_id,
          a.workspace_id,
          e.AGENTONIC_BOOTSTRAP_CUSTOMER_B_OWNER_EMAIL
        )
        assert.equal((await command("invite.accept", { tokenHash })).ok, true)
        const memberId = (
          await client.query("SELECT agentonic.current_member() AS id")
        ).rows[0].id
        assert.equal((await command("invite.accept", { tokenHash })).ok, false)
        await actor(a.auth_id)
        assert.equal(
          (
            await command("collection.share", {
              collectionId,
              memberId,
              permission: "read",
            })
          ).ok,
          true
        )
        await actor(b.auth_id)
        assert.equal(
          (
            await client.query(
              "SELECT * FROM agentonic.knowledge_collections WHERE id=$1",
              [collectionId]
            )
          ).rowCount,
          1
        )
        assert.equal(
          (
            await client.query(
              "SELECT agentonic.can_collection($1,'curate') AS allowed",
              [collectionId]
            )
          ).rows[0].allowed,
          false
        )
        await actor(a.auth_id)
        assert.equal(
          (
            await command("member.update", {
              memberId,
              role: "member",
              status: "removed",
            })
          ).ok,
          true
        )
        await actor(b.auth_id)
        assert.equal(
          (
            await client.query(
              "SELECT * FROM agentonic.knowledge_collections WHERE id=$1",
              [collectionId]
            )
          ).rowCount,
          0
        )
      }
      await client.query("ROLLBACK")
      const clean = await client.query(
        "SELECT nullif(current_setting('agentonic.auth_user_id',true),'') AS actor,nullif(current_setting('agentonic.workspace_id',true),'') AS workspace,nullif(current_setting('agentonic.verified_email',true),'') AS email"
      )
      assert.deepEqual(clean.rows[0], {
        actor: null,
        workspace: null,
        email: null,
      })
      await client.query("BEGIN READ ONLY")
      await actor(a.auth_id)
      assert.equal(
        (
          await client.query(
            "SELECT * FROM agentonic.knowledge_collections WHERE id=$1",
            [collectionId]
          )
        ).rowCount,
        0
      )
      console.log(
        `${role}: resource isolation, exact support access, revocation, protected ownership and context cleanup passed; test changes rolled back.`
      )
    } finally {
      await client.query("ROLLBACK")
      await client.end()
    }
  }
} catch (error) {
  fail(error)
}
