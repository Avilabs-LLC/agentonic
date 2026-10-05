import assert from "node:assert/strict"
import { setTimeout } from "node:timers"
import { createHash, randomUUID } from "node:crypto"
import { bootstrapConfig, loadLocal, connect, fail } from "./local-config.mjs"
import { rerankSmokeDocument, verifyRerankUsage } from "./rerank-live-proof.mjs"
// Explicit, paid, nonproduction smoke test. Uses only a temporary synthetic document.
// Run a separately configured worker first. Provider caps are enforced in the database.
let admin,
  customer,
  fixture,
  stage = "configuration"
const rerankCheck = process.argv.includes("--rerank")
try {
  if (!process.argv.includes("--live"))
    throw new Error("Explicit --live required")
  const { e } = bootstrapConfig(),
    env = loadLocal(".env.database.local"),
    worker = loadLocal("apps/worker/.env.local")
  assert.ok(
    worker.VOYAGE_API_KEY && e.SUPABASE_SECRET_KEY && worker.OPENAI_API_KEY
  )
  if (rerankCheck) assert.equal(worker.AGENTONIC_RERANK_ENABLED, "true")
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
          fn === "rag_command"
            ? "SELECT agentonic.rag_command($1,$2::jsonb) result"
            : `SELECT agentonic.${fn}($1,$2::jsonb,$3::uuid) result`,
          fn === "rag_command"
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
  stage = "create_fixture"
  const collection = await command(
    "collection.create",
    { name: "Synthetic RAG verification", slug: `rag-check-${randomUUID()}` },
    "access_command"
  )
  assert.equal(collection.ok, true)
  fixture = { collectionId: collection.id, command }
  const bytes = Buffer.from(
    rerankCheck
      ? rerankSmokeDocument
      : "# Synthetic device policy\n\nThe synthetic device warranty lasts three years. Standard delivery takes seven business days. Refund requests are accepted within thirty days of purchase.\n"
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
  stage = "upload_fixture"
  const upload = await globalThis.fetch(
    `${worker.SUPABASE_URL}/storage/v1/object/agentonic-documents/${fixture.key}`,
    {
      method: "POST",
      headers: {
        apikey: e.SUPABASE_SECRET_KEY,
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
  async function ask(query) {
    const queued = await command(
      "search",
      { query, collectionIds: [collection.id], generateAnswer: true },
      "rag_command"
    )
    const result = await waitFor(async () => {
      const result = await command("result", { id: queued.id }, "rag_command")
      if (["failed", "cancelled", "unavailable"].includes(result.status))
        throw new Error(`Retrieval ${result.error ?? result.status}`)
      return result.status === "succeeded" ? result : null
    })
    return { id: queued.id, result }
  }
  stage = "grounded_answer"
  const answered = await ask(
    "¿Cuántos años dura la garantía del dispositivo sintético?"
  )
  assert.ok(answered.result.matches.length > 0)
  assert.equal(answered.result.answer.insufficientEvidence, false)
  assert.ok(answered.result.answer.citations.length > 0)
  assert.match(answered.result.answer.text, /\b(3|tres|three)\b/i)
  if (rerankCheck)
    console.log(
      JSON.stringify({
        event: "preview_rerank_verified",
        ...(await verifyRerankUsage(admin, answered.id)),
      })
    )
  console.log(
    "Live hybrid retrieval and OpenAI answer: expected fact and valid citations passed."
  )
  stage = "abstention"
  // Respect the small development embedding quota between independent questions.
  if (rerankCheck) await new Promise((resolve) => setTimeout(resolve, 31000))
  const unknown = await ask(
    "¿Cuánto cuesta extender la garantía por un año adicional?"
  )
  assert.equal(unknown.result.answer.insufficientEvidence, true)
  console.log(
    "Unsupported question: explicit insufficient-evidence response passed."
  )
  stage = "isolation"
  await assert.rejects(
    command(
      "search",
      { query: "warranty", collectionIds: [collection.id] },
      "rag_command",
      members[1]
    ),
    { code: "42501" }
  )
  console.log(
    "Cross-workspace retrieval denied through the real customer database role."
  )
  stage = "delete_fixture"
  const versions = (
    await admin.query(
      "SELECT id,document_id FROM agentonic.document_versions WHERE object_id=$1",
      [fixture.objectId]
    )
  ).rows
  assert.equal(
    (await command("document.remove", { objectId: fixture.objectId })).ok,
    true
  )
  fixture.removed = true
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int n FROM agentonic.document_chunks WHERE document_version_id=ANY($1::uuid[])",
        [versions.map((v) => v.id)]
      )
    ).rows[0].n,
    0
  )
  const stale = await command("result", { id: answered.id }, "rag_command")
  assert.notEqual(stale.status, "succeeded")
  assert.ok(!stale.answer)
  stage = "physical_purge"
  await waitFor(
    async () =>
      (
        await admin.query(
          "SELECT 1 FROM agentonic.stored_objects WHERE id=$1",
          [fixture.objectId]
        )
      ).rowCount === 0
  )
  for (const [table, column, ids] of [
    ["document_versions", "id", versions.map((v) => v.id)],
    ["documents", "id", versions.map((v) => v.document_id)],
    ["knowledge_sources", "collection_id", [collection.id]],
    ["background_jobs", "object_id", [fixture.objectId]],
  ])
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::int n FROM agentonic.${table} WHERE ${column}=ANY($1::uuid[])`,
          [ids]
        )
      ).rows[0].n,
      0
    )
  const storageLookup = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  try {
    assert.equal(
      (
        await storageLookup.query(
          "SELECT count(*)::int n FROM storage.objects WHERE bucket_id='agentonic-documents' AND name=$1",
          [fixture.key]
        )
      ).rows[0].n,
      0
    )
  } finally {
    await storageLookup.end()
  }
  const download = await globalThis.fetch(
    `${worker.SUPABASE_URL}/storage/v1/object/agentonic-documents/${fixture.key}`,
    {
      headers: { apikey: e.SUPABASE_SECRET_KEY },
      signal: globalThis.AbortSignal.timeout(30000),
    }
  )
  assert.ok(!download.ok)
  console.log(
    "Deletion: immediate retrieval revocation, stale-answer invalidation, chunks/records purge and Storage disappearance passed."
  )
  stage = "complete"
} catch (error) {
  console.error("RAG live verification stage:", stage)
  // Controlled diagnostic only; never emit raw provider errors or connection details.
  if (error?.code)
    console.error(
      "Database diagnostic code:",
      String(error.code).replace(/[^A-Z0-9_]/g, "")
    )
  fail(error)
} finally {
  if (fixture?.objectId && !fixture.removed) {
    try {
      await fixture.command("document.remove", { objectId: fixture.objectId })
    } catch {
      console.error("Temporary RAG fixture cleanup needs a retry.")
      process.exitCode = 1
    }
  }
  if (fixture?.collectionId && admin) {
    try {
      await admin.query(
        "DELETE FROM agentonic.knowledge_collections WHERE id=$1 AND NOT EXISTS(SELECT 1 FROM agentonic.knowledge_sources WHERE collection_id=$1)",
        [fixture.collectionId]
      )
    } catch {
      console.error("Temporary RAG fixture cleanup needs a retry.")
      process.exitCode = 1
    }
  }
  await customer?.end()
  await admin?.end()
}
