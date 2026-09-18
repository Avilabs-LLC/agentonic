import { verifyStagingLive } from "./verify-staging-live.mjs"
import { rerankSmokeDocument, verifyRerankUsage } from "./rerank-live-proof.mjs"
import assert from "node:assert/strict"
import { randomUUID, createHash } from "node:crypto"
import { writeFileSync, existsSync, readFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import {
  bootstrapConfig,
  loadLocal,
  connect,
  fail,
  root,
} from "./local-config.mjs"
// Explicit synthetic nonproduction verification; never uses customer acceptance cases.
// Historical decisions/usage remain immutable in a retired synthetic workspace.
const stagingCheck = process.argv.includes("--staging")
const rerankCheck = process.argv.includes("--rerank")
const webCheck = process.argv.includes("--web")
assert.ok(!webCheck || stagingCheck, "Web verification requires --staging")
const marker = join(
  root,
  stagingCheck
    ? ".local/staging/live-check.json"
    : ".local/evaluation/review-flow-check.json"
)
let db,
  customer,
  staffClient,
  fixture,
  stage = "configuration"
try {
  assert.ok(
    process.argv.includes("--live") ||
      process.argv.includes("--cleanup") ||
      process.argv.includes("--resume") ||
      process.argv.includes("--resume-staging")
  )
  const { e, ref } = bootstrapConfig()
  assert.equal(ref, "jkgdxkacariasunhentd")
  const env = loadLocal(".env.database.local"),
    worker = loadLocal("apps/worker/.env.local")
  if (rerankCheck) assert.equal(worker.AGENTONIC_RERANK_ENABLED, "true")
  db = await connect(
    env.AGENTONIC_MIGRATION_DATABASE_URL,
    env.AGENTONIC_DATABASE_CA_FILE
  )
  customer = await connect(
    env.AGENTONIC_CUSTOMER_DATABASE_URL,
    env.AGENTONIC_DATABASE_CA_FILE
  )
  staffClient = await connect(
    env.AGENTONIC_ADMIN_DATABASE_URL,
    env.AGENTONIC_DATABASE_CA_FILE
  )
  const lookup = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  let owner, staff
  try {
    owner = (
      await lookup.query(
        "SELECT u.id,u.auth_user_id FROM agentonic.users u JOIN agentonic.workspace_members m ON m.user_id=u.id JOIN agentonic.workspaces w ON w.id=m.workspace_id WHERE w.slug='bootstrap-customer-a' AND m.role='owner' AND m.status='active' AND m.removed_at IS NULL AND u.deleted_at IS NULL"
      )
    ).rows[0]
    staff = (
      await lookup.query(
        "SELECT st.id,u.id user_id,u.auth_user_id FROM agentonic.platform_staff st JOIN agentonic.users u ON u.id=st.user_id JOIN auth.users a ON a.id=u.auth_user_id WHERE lower(a.email)=lower($1) AND st.role='administrator' AND st.disabled_at IS NULL",
        [e.AGENTONIC_BOOTSTRAP_STAFF_EMAIL]
      )
    ).rows[0]
    assert.ok(owner && staff)
  } finally {
    await lookup.end()
  }
  async function cmd(
    operation,
    payload = {},
    fn = "authoring_command",
    asStaff = false
  ) {
    const client = asStaff ? staffClient : customer
    await client.query("BEGIN")
    try {
      await client.query(
        "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id',$2,true)",
        [(asStaff ? staff : owner).auth_user_id, fixture.workspaceId]
      )
      const result = (
        await client.query(
          `SELECT agentonic.${fn}($1,$2::jsonb,$3::uuid) result`,
          [operation, JSON.stringify(payload), randomUUID()]
        )
      ).rows[0].result
      await client.query("COMMIT")
      assert.equal(result.ok, true)
      return result
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    }
  }
  async function waitFor(check) {
    const deadline = Date.now() + 600000
    while (Date.now() < deadline) {
      const result = await check()
      if (result) return result
      await new Promise((resolve) => globalThis.setTimeout(resolve, 2000))
    }
    throw new Error("Worker timed out")
  }
  async function cleanup() {
    assert.match(fixture.workspaceId, /^[a-f0-9-]{36}$/)
    const owned = await db.query(
      "SELECT 1 FROM agentonic.workspaces WHERE id=$1 AND slug LIKE 'eval-check-%' AND name='Synthetic evaluation verification'",
      [fixture.workspaceId]
    )
    assert.equal(owned.rowCount, 1)
    if (stagingCheck) {
      const deployments = await db.query(
        "SELECT id FROM agentonic.deployments WHERE workspace_id=$1 AND status IN ('awaiting_activation','queued','preparing','running')",
        [fixture.workspaceId]
      )
      for (const deployment of deployments.rows)
        await cmd(
          "stop",
          { deploymentId: deployment.id },
          "deployment_command",
          true
        )
    }
    if (
      fixture.objectId &&
      (
        await db.query("SELECT 1 FROM agentonic.stored_objects WHERE id=$1", [
          fixture.objectId,
        ])
      ).rowCount
    ) {
      await cmd("document.remove", { objectId: fixture.objectId })
      await waitFor(
        async () =>
          !(
            await db.query(
              "SELECT 1 FROM agentonic.stored_objects WHERE id=$1",
              [fixture.objectId]
            )
          ).rowCount
      )
    }
    if (fixture.preparationId)
      await cmd(
        "cancel",
        { preparationId: fixture.preparationId },
        "review_flow_command"
      )
    if (fixture.evaluationId && !fixture.preparationId)
      await cmd(
        "cancel",
        { evaluationId: fixture.evaluationId },
        "evaluation_command"
      )
    await db.query(
      "UPDATE agentonic.agents SET status='archived',archived_at=clock_timestamp() WHERE workspace_id=$1",
      [fixture.workspaceId]
    )
    await db.query(
      "UPDATE agentonic.workspaces SET deleted_at=clock_timestamp() WHERE id=$1",
      [fixture.workspaceId]
    )
    if (existsSync(marker)) unlinkSync(marker)
  }
  async function continueReview() {
    const preparation = { id: fixture.preparationId },
      submission = { id: fixture.submissionId }
    const scoped = await db.query(
      "SELECT 1 FROM agentonic.workspaces WHERE id=$1 AND slug LIKE 'eval-check-%' AND name='Synthetic evaluation verification'",
      [fixture.workspaceId]
    )
    assert.equal(scoped.rowCount, 1)
    const prepared = await waitFor(async () => {
      const p = (
        await db.query(
          "SELECT status,criteria,revision FROM agentonic.evaluation_preparations WHERE id=$1",
          [preparation.id]
        )
      ).rows[0]
      assert.ok(!["error", "cancelled"].includes(p.status))
      return p.status === "criteria_ready" ? p : null
    })
    // This fixture only authorizes expectations actually supported by its synthetic policy.
    // Keep generated scope/provenance; edits model the customer's persisted clarification.
    assert.ok(prepared.criteria.length >= 1)
    const criteria = prepared.criteria.map((c, i) => ({
      ...c,
      reviewDecision: "approved",
      expectedAnswer: c.needsInput
        ? "Debe indicar que no hay evidencia suficiente para responder esta pregunta con las fuentes disponibles."
        : c.expectedAnswer,
      needsInput: false,
      notes:
        i === 0
          ? "Synthetic customer note: use concise answers."
          : c.needsInput
            ? "Synthetic policy has only warranty duration and delivery time; do not invent additional conditions."
            : c.notes,
    }))
    await cmd(
      "save",
      { preparationId: preparation.id, revision: prepared.revision, criteria },
      "review_flow_command"
    )
    const plan = await cmd(
      "confirm",
      {
        preparationId: preparation.id,
        revision: prepared.revision + 1,
        consent: true,
      },
      "review_flow_command"
    )
    fixture.evaluationId = plan.id
    writeFileSync(marker, JSON.stringify(fixture), { mode: 0o600 })
    stage = "semantic_evaluation"
    const finished = await waitFor(async () => {
      const run = (
        await db.query(
          "SELECT status,error_code,environment,evidence_sha256,worker_id,committed_microusd FROM agentonic.evaluation_runs WHERE id=$1",
          [plan.id]
        )
      ).rows[0]
      if (["passed", "failed", "error", "cancelled"].includes(run.status))
        return run
    })
    console.log(
      JSON.stringify({
        environment: finished.environment,
        status: finished.status,
        errorCode: finished.error_code,
        committedMicrousd: Number(finished.committed_microusd),
      })
    )
    assert.equal(finished.status, "passed")
    const reranking = rerankCheck
      ? await verifyRerankUsage(db, plan.id)
      : undefined
    if (reranking)
      console.log(
        JSON.stringify({ event: "evaluation_rerank_verified", ...reranking })
      )
    const results = (
      await db.query(
        "SELECT outcome,assessment FROM agentonic.evaluation_results WHERE evaluation_run_id=$1",
        [plan.id]
      )
    ).rows
    assert.equal(results.length, criteria.length + 2)
    assert.ok(
      results.every(
        (r) => r.outcome === "passed" && r.assessment.verdict === "passed"
      )
    )
    stage = "automatic_approval"
    const decision = (
      await db.query(
        "SELECT id,actor_policy_version,assessment_snapshot,agentonic.version_approval_valid(id) valid FROM agentonic.submission_review_decisions WHERE submission_id=$1 AND decision='approved'",
        [submission.id]
      )
    ).rows[0]
    assert.ok(decision?.valid)
    assert.equal(decision.actor_policy_version, "readonly-review-v1")
    assert.equal(decision.assessment_snapshot.humanReviewed, false)
    if (stagingCheck) {
      stage = "staging_activation"
      await verifyStagingLive({
        db,
        customer,
        owner,
        fixture,
        cmd,
        waitFor,
        rerankCheck,
        webCheck,
      })
    }
    await cmd(
      "revoke",
      {
        submissionId: submission.id,
        feedback:
          "Synthetic verification completed; immediately revoke fixture approval.",
      },
      "evaluation_command",
      true
    )
    assert.equal(
      (
        await db.query("SELECT agentonic.version_approval_valid($1) valid", [
          decision.id,
        ])
      ).rows[0].valid,
      false
    )
    writeFileSync(
      join(root, ".local/evaluation/review-flow-report.json"),
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          environment: finished.environment,
          evaluationId: plan.id,
          evidenceSha256: finished.evidence_sha256,
          workerId: finished.worker_id,
          committedMicrousd: Number(finished.committed_microusd),
          ...(reranking ? { reranking } : {}),
          checks: [
            "synthetic ingestion",
            "explicit consent gate",
            "exact Azure runtime",
            "AI-generated grounded criteria",
            "persisted customer notes",
            "semantic grading",
            "abstention",
            "automatic policy approval",
            "immediate revocation",
          ],
        },
        null,
        2
      ) + "\n",
      { mode: 0o600 }
    )
    stage = "cleanup"
    await cleanup()
    console.log(
      "Synthetic Azure evaluation, approval boundary and revocation passed. Fixture document purged; workspace retired; usage preserved."
    )
  }
  if (process.argv.includes("--cleanup")) {
    fixture = JSON.parse(readFileSync(marker))
    await cleanup()
    console.log(
      "Synthetic workspace retired and document purged; immutable history and usage preserved."
    )
  } else if (process.argv.includes("--resume-staging")) {
    assert.ok(stagingCheck)
    fixture = JSON.parse(readFileSync(marker))
    const existing = await db.query(
      "SELECT id FROM agentonic.deployments WHERE workspace_id=$1 AND desired_state='running'",
      [fixture.workspaceId]
    )
    for (const d of existing.rows)
      await cmd("stop", { deploymentId: d.id }, "deployment_command", true)
    stage = "staging_activation"
    await verifyStagingLive({
      db,
      customer,
      owner,
      fixture,
      cmd,
      waitFor,
      rerankCheck,
      webCheck,
    })
    await cmd(
      "revoke",
      {
        submissionId: fixture.submissionId,
        feedback: "Synthetic staging verification completed.",
      },
      "evaluation_command",
      true
    )
    await cleanup()
    console.log(
      "Staging checks passed; synthetic workspace retired and document purged; usage retained."
    )
  } else if (process.argv.includes("--resume")) {
    fixture = JSON.parse(readFileSync(marker))
    await continueReview()
  } else {
    assert.ok(
      !existsSync(marker),
      "Clean the preceding synthetic fixture first"
    )
    fixture = { workspaceId: randomUUID() }
    writeFileSync(marker, JSON.stringify(fixture), { mode: 0o600 })
    stage = "workspace"
    await db.query("BEGIN")
    await db.query(
      "INSERT INTO agentonic.workspaces(id,kind,name,slug,timezone,retention_policy) VALUES($1,'organization','Synthetic evaluation verification',$2,'UTC',$3)",
      [
        fixture.workspaceId,
        `eval-check-${randomUUID()}`,
        JSON.stringify({
          conversationsDays: 7,
          checkpointsDays: 7,
          memoryDays: 7,
          sourcesDays: 7,
          logsDays: 7,
          auditDays: 30,
          backupsDays: 7,
        }),
      ]
    )
    await db.query(
      "INSERT INTO agentonic.workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [fixture.workspaceId, owner.id]
    )
    const release = (
      await db.query(
        "SELECT c.id,c.template_version_id FROM agentonic.code_releases c JOIN agentonic.evaluation_workers ew ON ew.runtime_sha256=c.artifact_sha256 WHERE ew.environment='azure_staging' AND ew.revoked_at IS NULL AND c.revoked_at IS NULL AND c.retired_at IS NULL ORDER BY c.created_at DESC LIMIT 1"
      )
    ).rows[0]
    assert.ok(release)
    await db.query(
      "INSERT INTO agentonic.workspace_code_release_grants(workspace_id,code_release_id,granted_by_staff_id) VALUES($1,$2,$3)",
      [fixture.workspaceId, release.id, staff.id]
    )
    await db.query("COMMIT")
    const collection = await cmd(
      "collection.create",
      { name: "Synthetic evidence", slug: `eval-evidence-${randomUUID()}` },
      "access_command"
    )
    fixture.collectionId = collection.id
    const bytes = Buffer.from(
      rerankCheck
        ? rerankSmokeDocument
        : "# Synthetic device policy\n\nThe synthetic device warranty lasts three years. Standard delivery takes seven business days.\n"
    )
    const reserved = await cmd("upload.reserve", {
      collectionId: collection.id,
      title: "synthetic-evaluation.md",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      contentType: "text/markdown",
    })
    fixture.objectId = reserved.id
    writeFileSync(marker, JSON.stringify(fixture), { mode: 0o600 })
    stage = "upload"
    const upload = await globalThis.fetch(
      `${worker.SUPABASE_URL}/storage/v1/object/agentonic-documents/${reserved.data.objectKey}`,
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
    assert.ok(upload.ok)
    await cmd("upload.complete", { objectId: reserved.id })
    stage = "ingestion"
    await waitFor(async () => {
      const job = (
        await db.query(
          "SELECT status FROM agentonic.background_jobs WHERE object_id=$1 AND kind='ingest' ORDER BY created_at DESC LIMIT 1",
          [reserved.id]
        )
      ).rows[0]
      assert.ok(!["failed", "cancelled"].includes(job?.status))
      return job?.status === "succeeded"
    })
    const agent = await cmd(
      "agent.create",
      {
        name: "Synthetic evaluation agent",
        slug: `eval-agent-${randomUUID()}`,
        templateVersionId: release.template_version_id,
      },
      "access_command"
    )
    fixture.agentId = agent.id
    writeFileSync(marker, JSON.stringify(fixture), { mode: 0o600 })
    await cmd("draft.save", {
      agentId: agent.id,
      revision: 0,
      content: {
        version: 1,
        systemPrompt:
          "Answer in English using the authorized passages. Be concise. If the evidence cannot answer the question, explicitly say there is insufficient evidence. Never invent a secret code." +
          (webCheck
            ? " When specifically asked for public documentation, use the authorized web tools, read a source and provide its URL."
            : ""),
        skills: [],
      },
      requestedAccess: {
        version: 1,
        collectionIds: [collection.id],
        tools: webCheck
          ? [{ capability: "web", operations: ["web.search", "web.read"] }]
          : [],
      },
    })
    const candidate = await cmd("candidate.freeze", {
      agentId: agent.id,
      revision: 1,
      codeReleaseId: release.id,
    })
    const submission = await cmd("submission.send", {
      candidateId: candidate.id,
      consent: true,
      note: "Automated synthetic infrastructure verification only.",
    })
    fixture.submissionId = submission.id
    stage = "ai_preparation"
    const preparation = await cmd(
      "prepare",
      {
        submissionId: submission.id,
        budgetUsd: stagingCheck ? 0.25 : 0.5,
        consent: true,
        requestId: randomUUID(),
      },
      "review_flow_command"
    )
    fixture.preparationId = preparation.id
    writeFileSync(marker, JSON.stringify(fixture), { mode: 0o600 })
    await continueReview()
  }
} catch (error) {
  await db?.query("ROLLBACK").catch(() => {})
  console.error("Evaluation verification stage:", stage)
  fail(error)
} finally {
  await db?.end()
  await customer?.end()
  await staffClient?.end()
}
