import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { bootstrapConfig, loadLocal, connect, fail } from "./local-config.mjs"
// No Auth changes, emails, paid calls or Storage blob writes. Every test write rolls back.
try {
  const { e } = bootstrapConfig()
  const env = loadLocal(".env.database.local")
  const lookup = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  let members, staff
  try {
    members = (
      await lookup.query(
        `SELECT u.auth_user_id auth_id,w.id workspace_id,w.slug FROM agentonic.workspaces w JOIN agentonic.workspace_members m ON m.workspace_id=w.id JOIN agentonic.users u ON u.id=m.user_id WHERE w.slug=ANY($1::text[]) AND m.role='owner' AND m.status='active' AND m.removed_at IS NULL AND u.deleted_at IS NULL ORDER BY w.slug`,
        [["bootstrap-customer-a", "bootstrap-customer-b"]]
      )
    ).rows
    assert.equal(members.length, 2)
    staff = (
      await lookup.query(
        `SELECT u.auth_user_id auth_id FROM agentonic.platform_staff s JOIN agentonic.users u ON u.id=s.user_id JOIN auth.users a ON a.id=u.auth_user_id WHERE lower(a.email)=lower($1) AND s.disabled_at IS NULL AND u.deleted_at IS NULL`,
        [e.AGENTONIC_BOOTSTRAP_STAFF_EMAIL]
      )
    ).rows[0]
    assert.ok(staff)
  } finally {
    await lookup.end()
  }
  for (const role of ["customer", "admin"]) {
    const db = await connect(
      env[`AGENTONIC_${role.toUpperCase()}_DATABASE_URL`],
      env.AGENTONIC_DATABASE_CA_FILE
    )
    try {
      await db.query("BEGIN")
      const actor = async (u, w) =>
        db.query(
          "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id',$2,true)",
          [u, w]
        )
      const call = async (fn, op, payload = {}) =>
        (
          await db.query(
            `SELECT agentonic.${fn}($1,$2::jsonb,$3::uuid) result`,
            [op, JSON.stringify(payload), randomUUID()]
          )
        ).rows[0].result
      const command = (op, payload = {}) =>
        call("authoring_command", op, payload)
      await actor(members[0].auth_id, members[0].workspace_id)
      const list = await command("list")
      assert.equal(list.ok, true)
      const template = list.data.templates[0]
      assert.ok(template, "Publish the real authoring template first")
      const collection = await call("access_command", "collection.create", {
        name: "Temporary authoring verification",
        slug: `verify-${randomUUID()}`,
      })
      assert.equal(collection.ok, true)
      const agent = await call("access_command", "agent.create", {
        name: "Temporary authoring verification",
        slug: `verify-${randomUUID()}`,
        description: "Synthetic rollback-only fixture",
        templateVersionId: template.id,
      })
      assert.equal(agent.ok, true)
      const payload = {
        agentId: agent.id,
        revision: 0,
        content: {
          version: 1,
          systemPrompt: "Answer synthetic test questions.",
          skills: [],
        },
        requestedAccess: {
          version: 1,
          collectionIds: [collection.id],
          tools: [],
        },
      }
      assert.equal((await command("draft.save", payload)).ok, true)
      assert.equal((await command("draft.save", payload)).code, "conflict")
      const frozen = await command("candidate.freeze", {
        agentId: agent.id,
        revision: 1,
        codeReleaseId: template.codeReleaseId,
      })
      assert.equal(frozen.ok, true)
      const submission = await command("submission.send", {
        candidateId: frozen.id,
        note: "Synthetic rollback-only fixture",
        consent: true,
      })
      assert.equal(submission.ok, true)
      const upload = await command("upload.reserve", {
        collectionId: collection.id,
        title: "synthetic.txt",
        sha256: "a".repeat(64),
        size: 4,
        contentType: "text/plain",
      })
      assert.equal(upload.ok, true)
      assert.equal(
        (await command("upload.complete", { objectId: upload.id })).ok,
        false
      )
      await actor(members[1].auth_id, members[1].workspace_id)
      assert.equal((await command("detail", { agentId: agent.id })).ok, false)
      if (role === "admin") {
        await actor(staff.auth_id, members[0].workspace_id)
        const review = await command("review.open", {
          submissionId: submission.id,
        })
        assert.equal(review.ok, true)
        assert.equal(
          review.data.content.systemPrompt,
          payload.content.systemPrompt
        )
        assert.equal(
          (
            await command("review.decide", {
              submissionId: submission.id,
              grantId: review.data.grantId,
              decision: "changes_requested",
              feedback: "Synthetic review feedback",
            })
          ).ok,
          true
        )
        assert.equal(
          (
            await command("review.read", {
              submissionId: submission.id,
              grantId: review.data.grantId,
            })
          ).ok,
          false
        )
      }
      await db.query("SET CONSTRAINTS ALL IMMEDIATE")
      await db.query("ROLLBACK")
      const context = (
        await db.query(
          "SELECT nullif(current_setting('agentonic.auth_user_id',true),'') actor"
        )
      ).rows[0]
      assert.equal(context.actor, null)
      console.log(
        `${role}: real catalog, draft revisions, frozen submissions, upload reservation and tenant isolation passed${role === "admin" ? ", exact review and feedback passed" : ""}; all test changes rolled back.`
      )
    } finally {
      await db.query("ROLLBACK")
      await db.end()
    }
  }
} catch (error) {
  fail(error)
}
