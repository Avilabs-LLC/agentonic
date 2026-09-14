import assert from "node:assert/strict"
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { setTimeout } from "node:timers"
import { createHash, randomUUID } from "node:crypto"
import {
  bootstrapConfig,
  loadLocal,
  connect,
  fail,
  root,
} from "./local-config.mjs"
// Explicit, paid, nonproduction smoke test. Uses only a temporary synthetic document.
// Run a separately configured worker first. Provider caps are enforced in the database.
let admin,
  customer,
  fixture,
  cleanupFixture,
  stage = "configuration"
try {
  if (!process.argv.includes("--live") && !process.argv.includes("--cleanup"))
    throw new Error("Explicit --live required")
  const { e } = bootstrapConfig(),
    env = loadLocal(".env.database.local"),
    worker = loadLocal("apps/worker/.env.local")
  assert.ok(
    worker.VOYAGE_API_KEY && worker.SUPABASE_SECRET_KEY && worker.OPENAI_API_KEY
  )
  admin = await connect(
    env.AGENTONIC_MIGRATION_DATABASE_URL,
    env.AGENTONIC_DATABASE_CA_FILE
  )
  customer = await connect(
    env.AGENTONIC_CUSTOMER_DATABASE_URL,
    env.AGENTONIC_DATABASE_CA_FILE
  )
  const lookup = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  let members
  try {
    members = (
      await lookup.query(
        "SELECT u.auth_user_id auth_id,w.id workspace_id FROM agentonic.workspaces w JOIN agentonic.workspace_members m ON m.workspace_id=w.id JOIN agentonic.users u ON u.id=m.user_id WHERE w.slug=ANY($1::text[]) AND m.role='owner' AND m.status='active' AND m.removed_at IS NULL AND u.deleted_at IS NULL ORDER BY w.slug",
        [["bootstrap-customer-a", "bootstrap-customer-b"]]
      )
    ).rows
    assert.equal(members.length, 2)
  } finally {
    await lookup.end()
  }
  async function command(
    operation,
    payload = {},
    fn = "authoring_command",
    member = members[0]
  ) {
    await customer.query("BEGIN")
    try {
      await customer.query(
        "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id',$2,true)",
        [member.auth_id, member.workspace_id]
      )
      const result = (
        await customer.query(
          ["rag_command", "preview_command"].includes(fn)
            ? `SELECT agentonic.${fn}($1,$2::jsonb) result`
            : `SELECT agentonic.${fn}($1,$2::jsonb,$3::uuid) result`,
          ["rag_command", "preview_command"].includes(fn)
            ? [operation, JSON.stringify(payload)]
            : [operation, JSON.stringify(payload), randomUUID()]
        )
      ).rows[0].result
      await customer.query("COMMIT")
      return result
    } catch (error) {
      await customer.query("ROLLBACK")
      throw error
    }
  }
  async function waitFor(check) {
    const deadline = Date.now() + 120000
    while (Date.now() < deadline) {
      const result = await check()
      if (result) return result
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    throw new Error("Worker timed out")
  }
  const marker = join(root, ".local/preview-check.json")
  async function cleanup(data) {
    const collection = await admin.query(
      "SELECT 1 FROM agentonic.knowledge_collections WHERE id=$1 AND workspace_id=$2 AND slug LIKE 'rag-check-%' AND name='Synthetic RAG verification'",
      [data.collectionId, members[0].workspace_id]
    )
    assert.equal(collection.rowCount, 1)
    if (data.objectId) {
      const object = await admin.query(
        "SELECT 1 FROM agentonic.document_versions v JOIN agentonic.documents d ON d.id=v.document_id JOIN agentonic.knowledge_sources s ON s.id=d.source_id WHERE v.object_id=$1 AND s.collection_id=$2 AND d.workspace_id=$3",
        [data.objectId, data.collectionId, members[0].workspace_id]
      )
      const present = await admin.query(
        "SELECT 1 FROM agentonic.stored_objects WHERE id=$1",
        [data.objectId]
      )
      assert.ok(!present.rowCount || object.rowCount === 1)
    }
    if (data.agentId) {
      const owned = await admin.query(
        "SELECT 1 FROM agentonic.agents WHERE id=$1 AND workspace_id=$2 AND slug LIKE 'preview-check-%'",
        [data.agentId, members[0].workspace_id]
      )
      assert.equal(owned.rowCount, 1)
    }
    if (data.objectId) {
      const present = await admin.query(
        "SELECT 1 FROM agentonic.stored_objects WHERE id=$1",
        [data.objectId]
      )
      if (present.rowCount) {
        assert.equal(
          (await command("document.remove", { objectId: data.objectId })).ok,
          true
        )
        await waitFor(
          async () =>
            (
              await admin.query(
                "SELECT 1 FROM agentonic.stored_objects WHERE id=$1",
                [data.objectId]
              )
            ).rowCount === 0
        )
      }
    }
    await admin.query("BEGIN")
    try {
      if (data.agentId) {
        await admin.query(
          "DELETE FROM agentonic.background_jobs WHERE preview_id IN (SELECT id FROM agentonic.agent_previews WHERE agent_id=$1)",
          [data.agentId]
        )
        await admin.query(
          "DELETE FROM agentonic.agent_previews WHERE agent_id=$1",
          [data.agentId]
        )
        await admin.query(
          "DELETE FROM agentonic.configuration_releases WHERE agent_id=$1",
          [data.agentId]
        )
        await admin.query(
          "DELETE FROM agentonic.configuration_drafts WHERE agent_id=$1",
          [data.agentId]
        )
        await admin.query("DELETE FROM agentonic.agents WHERE id=$1", [
          data.agentId,
        ])
      }
      await admin.query(
        "DELETE FROM agentonic.knowledge_collections WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM agentonic.knowledge_sources WHERE collection_id=$1)",
        [data.collectionId]
      )
      await admin.query("COMMIT")
    } catch (error) {
      await admin.query("ROLLBACK")
      throw error
    }
    if (existsSync(marker)) unlinkSync(marker)
  }
  cleanupFixture = cleanup
  if (process.argv.includes("--cleanup")) {
    await cleanup(JSON.parse(readFileSync(marker, "utf8")))
    console.log(
      "Synthetic preview fixture removed; content-free usage preserved."
    )
  } else {
    assert.equal(
      existsSync(marker),
      false,
      "Clean the previous synthetic fixture before another paid run"
    )
    stage = "create_fixture"
    const collection = await command(
      "collection.create",
      { name: "Synthetic RAG verification", slug: `rag-check-${randomUUID()}` },
      "access_command"
    )
    assert.equal(collection.ok, true)
    fixture = { collectionId: collection.id, command }
    const bytes = Buffer.from(
      "# Synthetic device policy\n\nThe synthetic device warranty lasts three years. Standard delivery takes seven business days. Refund requests are accepted within thirty days of purchase.\n"
    )
    const reserved = await command("upload.reserve", {
      collectionId: collection.id,
      title: "synthetic-rag-verification.md",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      contentType: "text/markdown",
    })
    assert.equal(reserved.ok, true)
    fixture.objectId = reserved.id
    fixture.key = reserved.data.objectKey
    writeFileSync(
      marker,
      JSON.stringify({
        collectionId: fixture.collectionId,
        objectId: fixture.objectId,
      }),
      { mode: 0o600 }
    )
    stage = "upload_fixture"
    const upload = await globalThis.fetch(
      `${worker.SUPABASE_URL}/storage/v1/object/agentonic-documents/${fixture.key}`,
      {
        method: "POST",
        headers: {
          apikey: worker.SUPABASE_SECRET_KEY,
          "Content-Type": "text/markdown",
          "x-upsert": "false",
        },
        body: bytes,
        signal: globalThis.AbortSignal.timeout(30000),
      }
    )
    assert.ok(upload.ok, `Storage HTTP ${upload.status}`)
    assert.equal(
      (await command("upload.complete", { objectId: fixture.objectId })).ok,
      true
    )
    stage = "ingestion"
    await waitFor(async () => {
      const job = (
        await admin.query(
          "SELECT status,error_code FROM agentonic.background_jobs WHERE object_id=$1 AND kind='ingest' ORDER BY created_at DESC LIMIT 1",
          [fixture.objectId]
        )
      ).rows[0]
      if (job?.status === "failed" || job?.status === "cancelled")
        throw new Error(`Ingestion ${job.error_code ?? job.status}`)
      return job?.status === "succeeded"
    })
    console.log(
      "Live ingestion: private upload, extraction, Voyage embedding and atomic publication passed."
    )

    stage = "create_agent"
    const release = (
      await admin.query(
        "SELECT id,template_version_id FROM agentonic.code_releases WHERE execution_manifest->>'previewContract'='1' AND revoked_at IS NULL AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1"
      )
    ).rows[0]
    assert.ok(release)
    const agent = await command(
      "agent.create",
      {
        name: "Prueba sintética del runtime",
        slug: `preview-check-${randomUUID()}`,
        templateVersionId: release.template_version_id,
      },
      "access_command"
    )
    assert.equal(agent.ok, true)
    fixture.agentId = agent.id
    writeFileSync(
      marker,
      JSON.stringify({
        agentId: fixture.agentId,
        collectionId: fixture.collectionId,
        objectId: fixture.objectId,
      }),
      { mode: 0o600 }
    )
    const content = {
      version: 1,
      systemPrompt:
        "Eres un asistente de prueba. Responde en español y comienza cada respuesta con PRUEBA.",
      skills: [
        {
          name: "breve",
          instructions: "Responde en un máximo de dos oraciones.",
        },
      ],
    }
    const requestedAccess = {
      version: 1,
      collectionIds: [collection.id],
      tools: [],
    }
    assert.equal(
      (
        await command("draft.save", {
          agentId: agent.id,
          revision: 0,
          content,
          requestedAccess,
        })
      ).ok,
      true
    )
    const frozen = await command("candidate.freeze", {
      agentId: agent.id,
      revision: 1,
      codeReleaseId: release.id,
    })
    assert.equal(frozen.ok, true)
    const started = await command(
      "start",
      { agentId: agent.id, candidateId: frozen.id },
      "preview_command"
    )
    assert.equal(started.ok, true)
    fixture.previewId = started.id
    writeFileSync(
      marker,
      JSON.stringify({
        agentId: agent.id,
        collectionId: collection.id,
        objectId: fixture.objectId,
        previewId: started.id,
        workspaceId: members[0].workspace_id,
      }),
      { mode: 0o600 }
    )
    const preview = (operation, payload = {}, member = members[0]) =>
      command(
        operation,
        { agentId: agent.id, previewId: started.id, ...payload },
        "preview_command",
        member
      )
    async function ask(query) {
      const queued = await preview("turn", { query, requestKey: randomUUID() })
      assert.equal(queued.ok, true)
      return waitFor(async () => {
        const state = await preview("state")
        assert.equal(state.ok, true)
        const turn = state.turns.find((t) => t.id === queued.id)
        if (["failed", "cancelled", "unavailable"].includes(turn?.status))
          throw new Error("Preview turn failed")
        return turn?.status === "succeeded" ? turn : null
      })
    }
    stage = "frozen_answer"
    assert.equal(
      (
        await command("draft.save", {
          agentId: agent.id,
          revision: 1,
          content: { ...content, systemPrompt: "Comienza con BORRADOR." },
          requestedAccess,
        })
      ).ok,
      true
    )
    const first = await ask(
      "¿Cuántos años dura la garantía del dispositivo sintético?"
    )
    assert.match(first.answer.text, /PRUEBA/)
    assert.match(first.answer.text, /\b(3|tres)\b/i)
    assert.equal(first.answer.insufficientEvidence, false)
    assert.ok(first.answer.citations.length)
    console.log(
      "Exact frozen runtime: verified artifact, original persona, selected skills and cited answer passed."
    )
    stage = "follow_up"
    const followup = await ask("¿Y cuánto tarda la entrega?")
    assert.match(followup.answer.text, /\b(7|siete)\b/i)
    assert.ok(followup.answer.citations.length)
    console.log(
      "Serialized follow-up with reconstructed private history passed."
    )
    stage = "abstention"
    // Ingestion plus two retrievals can exhaust a development provider's minute
    // window. Pace the next new request; do not replay a failed/unknown operation.
    console.log(
      "Pacing the final live question before a new provider minute window."
    )
    await new Promise((resolve) => setTimeout(resolve, 65000))
    const unknown = await ask(
      "¿Cuánto cuesta extender la garantía por un año adicional?"
    )
    assert.equal(unknown.answer.insufficientEvidence, true)
    const denied = await preview("state", {}, members[1])
    assert.equal(denied.ok, false)
    console.log(
      "Insufficient-evidence response and cross-workspace transcript isolation passed."
    )
    if (process.argv.includes("--keep-fixture"))
      console.log(
        `Synthetic UI fixture: http://localhost:3101/agents/${agent.id}/preview?workspace=${members[0].workspace_id}`
      )
    else {
      await cleanup(fixture)
      fixture = null
      console.log(
        "Synthetic documents and preview records removed; metering preserved."
      )
    }
  }
} catch (error) {
  console.error("Preview live verification stage:", stage)
  if (error?.code)
    console.error(
      "Database diagnostic code:",
      String(error.code).replace(/[^A-Z0-9_]/g, "")
    )
  fail(error)
} finally {
  if (fixture && cleanupFixture && !process.argv.includes("--keep-fixture")) {
    try {
      await cleanupFixture(fixture)
    } catch {
      console.error(
        "Synthetic preview cleanup needs a retry: node scripts/check-preview-live.mjs --cleanup"
      )
      process.exitCode = 1
    }
  }
  await customer?.end()
  await admin?.end()
}
