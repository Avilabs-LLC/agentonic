import { readFileSync } from "node:fs"
import type { PGlite } from "@electric-sql/pglite"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
const submissionMocks = vi.hoisted(() => ({
  identity: vi.fn(),
  auth: vi.fn(),
  query: vi.fn(),
}))
vi.mock("@agentonic/database/client", () => ({
  withIdentity: submissionMocks.identity,
}))
vi.mock("../packages/server/src/auth", () => ({
  requireVerifiedUser: submissionMocks.auth,
}))
import { submitAgentForReview } from "../packages/server/src/submission"
import { reviewReceipt } from "../packages/contracts/src/review-receipt"
import { runtimeRegistrations } from "../packages/contracts/src/expiry"
import { reviewQueue } from "../packages/contracts/src/authoring"
import { preparedDatabase } from "../scripts/prepared-database"
import {
  Controller,
  metadata,
  pollResult,
  type ControllerSystem,
} from "../apps/worker/src/staging-controller"
let db: PGlite
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const w = id(10),
  otherW = id(11),
  owner = id(1),
  other = id(2),
  staff = id(3),
  member = id(101),
  otherMember = id(102),
  a = id(20),
  collection = id(30),
  code = id(40),
  template = id(50)
const content = {
  version: 1,
  systemPrompt: "Help organize a synthetic project.",
  skills: [{ name: "summarize", instructions: "Use concise summaries." }],
}
let requested: {
  version: number
  collectionIds: string[]
  tools: (
    | { connectionId: string; operations: string[] }
    | { capability: "web"; operations: string[] }
  )[]
} = { version: 1, collectionIds: [collection], tools: [] }
async function actor(user = owner, workspace = w, role = "agentonic_customer") {
  await db.exec(`RESET ROLE; SET LOCAL ROLE ${role}`)
  await db.query(
    "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id',$2,true)",
    [user, workspace]
  )
}
async function command(
  operation: string,
  payload: Record<string, unknown> = {}
) {
  await db.exec("SAVEPOINT authoring_test")
  try {
    const r = await db.query<{
      result: {
        ok: boolean
        id: string
        data: {
          agents: unknown[]
          templates: unknown[]
          draft: { content: typeof content }
          content: typeof content
          grantId: string
          objectKey: string
          candidates: { id: string }[]
          submissions: { decisions: { feedback: string }[] }[]
        }
        code?: string
      }
    }>("SELECT agentonic.authoring_command($1,$2::jsonb,$3::uuid) result", [
      operation,
      JSON.stringify(payload),
      id(999),
    ])
    await db.exec("RELEASE SAVEPOINT authoring_test")
    return r.rows[0]!.result
  } catch (e) {
    await db.exec(
      "ROLLBACK TO SAVEPOINT authoring_test; RELEASE SAVEPOINT authoring_test"
    )
    throw e
  }
}
async function sql(q: string, params: unknown[] = []) {
  await db.exec("RESET ROLE")
  return db.query(q, params)
}
async function save(revision = 0) {
  return command("draft.save", {
    agentId: a,
    revision,
    content,
    requestedAccess: requested,
  })
}
beforeEach(async () => {
  db = await preparedDatabase([
    `CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE agentonic_migrator;
 CREATE ROLE agentonic_admin NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_customer NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_worker NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_deployer_local NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_deployer_azure NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_runtime_local NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_runtime_azure NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_eval_local NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_eval_azure NOSUPERUSER NOBYPASSRLS;
 CREATE SCHEMA agentonic_bootstrap;
 CREATE FUNCTION agentonic_bootstrap.link_auth_users() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $f$ ALTER TABLE agentonic.users ADD CONSTRAINT users_auth_user_fk FOREIGN KEY(auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT; $f$;
 CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,public boolean,file_size_limit bigint); INSERT INTO storage.buckets VALUES('agentonic-documents',false,10485760);
 CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text,metadata jsonb); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; GRANT USAGE ON SCHEMA storage TO authenticated; GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;`,
    readFileSync("scripts/sql/storage-boundary.sql", "utf8"),
    ...[
      "202609130001_identity",
      "202609130002_access",
      "202609130003_authoring",
      "202609130004_deferred_owner_checks",
      "202609130005_page_reads",
      "202609140006_agent_listing",
      "202609140007_rag",
      "202609140008_previews",
      "202609140009_preview_followups",
      "202609140010_collection_deletion",
      "202609150011_preview_discovery",
      "202609150012_review_queue",
      "202609150013_evaluations",
      "202609150014_evaluation_evidence_views",
      "202609150015_evaluation_retention",
      "202609150017_automatic_review",
      "202609150018_review_outcomes",
      "202609150019_criterion_decisions",
      "202609150020_review_summary",
      "202609150021_approved_receipts",
      "202609160022_approval_renewal",
      "202609160023_staging_deployments",
      "202609160024_activation_authority",
      "202609160025_staging_runtime_contract",
      "202609160026_staging_content_cleanup",
      "202609160027_staging_agent_listing",
      "202609180028_reranking",
      "202609180029_gmail",
      "202609180030_gmail_preview",
      "202609180031_web_access",
      "202609180032_web_research",
    ].map((migration) =>
      readFileSync(
        `packages/database/prisma/migrations/${migration}/migration.sql`,
        "utf8"
      )
    ),
    `INSERT INTO auth.users VALUES('${owner}'),('${other}'),('${staff}');
 INSERT INTO agentonic.users(id,auth_user_id,display_name) VALUES('${owner}','${owner}','Owner'),('${other}','${other}','Other'),('${staff}','${staff}','Staff');
 BEGIN;
 INSERT INTO agentonic.workspaces(id,kind,name,slug,timezone,retention_policy) VALUES('${w}','organization','A','a','UTC','{"conversationsDays":7,"checkpointsDays":7,"memoryDays":7,"sourcesDays":7,"logsDays":7,"auditDays":30,"backupsDays":7}'),('${otherW}','organization','B','b','UTC','{"conversationsDays":7,"checkpointsDays":7,"memoryDays":7,"sourcesDays":7,"logsDays":7,"auditDays":30,"backupsDays":7}');
 INSERT INTO agentonic.workspace_members(id,workspace_id,user_id,role) VALUES('${member}','${w}','${owner}','owner'),('${otherMember}','${otherW}','${other}','owner');COMMIT;
 INSERT INTO agentonic.platform_staff(id,user_id,role) VALUES('${staff}','${staff}','administrator');
 INSERT INTO agentonic.code_repositories(id,name,repository_url,visibility,provisioning_status,created_by_staff_id) VALUES('${id(60)}','Synthetic','https://example.invalid/runtime','platform','ready','${staff}');
 INSERT INTO agentonic.agent_templates(id,slug,name,code_repository_id) VALUES('${id(51)}','synthetic','Synthetic','${id(60)}');
 INSERT INTO agentonic.template_versions(id,template_id,version,git_commit_sha,manifest_sha256,structure_manifest,runtime_contract_version) VALUES('${template}','${id(51)}','0.1.0',repeat('a',40),repeat('b',64),'{"platformPolicyText":"Synthetic platform policy"}','0.1');
 INSERT INTO agentonic.code_releases(id,version,template_version_id,git_commit_sha,artifact_sha256,registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,artifact_key,artifact_size_bytes,published_by_staff_id,execution_manifest) VALUES('${code}','0.1.0','${template}',repeat('a',40),repeat('b',64),repeat('c',64),'0.1','${id(60)}','synthetic','fixture',100,'${staff}','{"previewContract":"1","gmailContract":"1","webContract":"1","model":"gpt-4.1-mini-2025-04-14"}');
 INSERT INTO agentonic.workspace_code_release_grants(workspace_id,code_release_id,granted_by_staff_id) VALUES('${w}','${code}','${staff}');
 INSERT INTO agentonic.agents(id,workspace_id,name,slug,owner_member_id,template_version_id,created_by_member_id) VALUES('${a}','${w}','Synthetic agent','synthetic','${member}','${template}','${member}');
 INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,owner_member_id) VALUES('${collection}','${w}','Knowledge','knowledge','${member}');`,
  ])
})
beforeEach(async () => {
  requested = { version: 1, collectionIds: [collection], tools: [] }
  await db.exec("RESET ROLE;BEGIN")
  await actor()
})
afterEach(async () => {
  try {
    await db.exec("ROLLBACK;RESET ROLE")
  } finally {
    await db.close()
  }
})
type Job = { id: string; token: string; kind: string }
async function worker(
  job: Job,
  operation: string,
  payload: Record<string, unknown> = {}
) {
  await db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
  const r = await db.query<{ result: Record<string, unknown> }>(
    "SELECT agentonic.rag_worker($1,$2::uuid,$3::uuid,$4::jsonb) result",
    [operation, job.id, job.token, JSON.stringify(payload)]
  )
  return r.rows[0]!.result
}
async function claim() {
  await db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
  const r = await db.query<{ result: Job | null }>(
    "SELECT agentonic.rag_claim(false) result"
  )
  return r.rows[0]!.result!
}
async function upload(collectionId = collection) {
  await actor()
  const r = await command("upload.reserve", {
    collectionId,
    title: "fixture.md",
    sha256: "a".repeat(64),
    size: 120,
    contentType: "text/markdown",
  })
  expect(r.ok).toBe(true)
  await sql(
    'INSERT INTO storage.objects(bucket_id,name,metadata) VALUES(\'agentonic-documents\',$1,\'{"size":120,"mimetype":"text/markdown"}\')',
    [`${w}/${r.id}`]
  )
  await actor()
  expect((await command("upload.complete", { objectId: r.id })).ok).toBe(true)
  return r.id
}
const embedding = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))
async function publish(
  job: Job,
  text = "The warranty lasts three years. La garantía dura tres años."
) {
  await worker(job, "publish", {
    parser: "text-v1",
    chunks: [
      {
        text,
        locator: { page: 1, start: 0, end: text.length },
        embedding:
          text === "Later source"
            ? embedding.map((n, i) => (i === 1 ? 0.1 : n))
            : embedding,
      },
    ],
  })
}

const cases = [
  {
    key: "duration",
    question: "How long is the warranty?",
    expectedAnswer: "The warranty lasts three years.",
    requiredPhrases: ["three years"],
    forbiddenPhrases: ["ten years"],
    insufficientEvidence: false,
  },
  {
    key: "warranty",
    question: "What is the warranty duration?",
    expectedAnswer: "The warranty lasts three years.",
    requiredPhrases: ["three years"],
    forbiddenPhrases: [],
    insufficientEvidence: false,
  },
  {
    key: "unknown",
    question: "What is the secret access code?",
    expectedAnswer: "There is insufficient evidence.",
    requiredPhrases: [],
    forbiddenPhrases: ["1234"],
    insufficientEvidence: true,
  },
]
async function evalCommand(
  operation: string,
  payload: Record<string, unknown>
) {
  await db.exec("SAVEPOINT eval_command")
  try {
    const r = await db.query<{ result: { ok: boolean; id: string } }>(
      "SELECT agentonic.evaluation_command($1,$2::jsonb,$3) result",
      [operation, JSON.stringify(payload), id(900)]
    )
    await db.exec("RELEASE SAVEPOINT eval_command")
    return r.rows[0]!.result
  } catch (error) {
    await db.exec(
      "ROLLBACK TO SAVEPOINT eval_command; RELEASE SAVEPOINT eval_command"
    )
    throw error
  }
}
async function plan(environment = "azure_staging") {
  await upload()
  await publish(await claim())
  await actor()
  await save()
  const candidate = await command("candidate.freeze", {
    agentId: a,
    revision: 1,
    codeReleaseId: code,
  })
  const submission = await command("submission.send", {
    candidateId: candidate.id,
    consent: true,
    note: "Synthetic review",
  })
  await actor(staff, w, "agentonic_admin")
  const grant = await command("review.open", { submissionId: submission.id })
  const e = await evalCommand("plan", {
    submissionId: submission.id,
    grantId: grant.data.grantId,
    cases,
    environment,
    budgetUsd: 0.25,
  })
  return {
    evaluationId: e.id,
    submissionId: submission.id,
    grantId: grant.data.grantId,
    candidateId: candidate.id,
  }
}
async function authorize(evaluationId: string) {
  const r = await sql(
    "SELECT dataset_sha256 FROM agentonic.evaluation_runs WHERE id=$1",
    [evaluationId]
  )
  await actor()
  return evalCommand("authorize", {
    evaluationId,
    datasetHash: (r.rows[0] as { dataset_sha256: string }).dataset_sha256,
    consent: true,
  })
}
async function register(environment = "azure_staging") {
  await sql(
    "INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,runtime_sha256,verified_at,verification) VALUES($1,$2,repeat('d',64),repeat('b',64),now(),$3)",
    [
      environment === "local" ? "agentonic_eval_local" : "agentonic_eval_azure",
      environment,
      JSON.stringify({
        isolation: true,
        recovery: true,
        artifactIntegrity: true,
      }),
    ]
  )
}
async function evalClaim(environment = "azure_staging") {
  await db.exec(
    `RESET ROLE; SET LOCAL ROLE ${environment === "local" ? "agentonic_eval_local" : "agentonic_eval_azure"}`
  )
  const r = await db.query<{ result: Job | null }>(
    "SELECT agentonic.evaluation_claim(repeat('d',64)) result"
  )
  return r.rows[0]!.result
}
async function execute(
  job: Job,
  operation: string,
  payload: Record<string, unknown> = {}
) {
  await db.exec("SAVEPOINT eval_worker")
  try {
    const r = await db.query<{ result: Record<string, unknown> }>(
      "SELECT agentonic.evaluation_worker($1,$2,$3,$4) result",
      [operation, job.id, job.token, JSON.stringify(payload)]
    )
    await db.exec("RELEASE SAVEPOINT eval_worker")
    return r.rows[0]!.result
  } catch (error) {
    await db.exec(
      "ROLLBACK TO SAVEPOINT eval_worker; RELEASE SAVEPOINT eval_worker"
    )
    throw error
  }
}
async function finish(job: Job, correct = true) {
  for (let i = 0; i < 3; i++) {
    await execute(job, "search", { embedding })
    const context = await execute(job, "context")
    const passages = context.passages as { id: string }[]
    await execute(job, "answer", {
      text:
        i === 2
          ? "There is insufficient evidence."
          : correct
            ? "The warranty lasts three years."
            : "The warranty lasts ten years.",
      citations: i === 2 ? [] : passages.map((p) => p.id),
      insufficientEvidence: i === 2,
      model: "gpt-4.1-mini-2025-04-14",
    })
  }
}
async function approve(p: Awaited<ReturnType<typeof plan>>) {
  const e = await sql(
    "SELECT evidence_sha256 FROM agentonic.evaluation_runs WHERE id=$1",
    [p.evaluationId]
  )
  await actor(staff, w, "agentonic_admin")
  return evalCommand("approve", {
    evaluationId: p.evaluationId,
    grantId: p.grantId,
    evidenceHash: (e.rows[0] as { evidence_sha256: string }).evidence_sha256,
    reviewed: true,
    feedback: "Reviewed all synthetic evidence.",
  })
}
it("requires explicit customer consent before any worker can claim", async () => {
  const p = await plan()
  await register()
  expect(await evalClaim()).toBeNull()
  await authorize(p.evaluationId)
  expect(await evalClaim()).toMatchObject({ id: p.evaluationId })
})
it("records exact frozen execution and approves only complete Azure evidence without deploying", async () => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  const job = (await evalClaim())!
  const context = await execute(job, "context")
  expect(JSON.parse(String(context.configurationJson))).toEqual(content)
  await finish(job)
  expect((await approve(p)).ok).toBe(true)
  const result = await sql(
    "SELECT s.status,d.assessment_snapshot,d.approval_expires_at IS NOT NULL expires FROM agentonic.agent_submissions s JOIN agentonic.submission_review_decisions d ON d.submission_id=s.id WHERE s.id=$1",
    [p.submissionId]
  )
  expect(result.rows).toMatchObject([
    {
      status: "approved",
      expires: true,
      assessment_snapshot: {
        evaluated: true,
        humanReviewed: true,
        evaluationId: p.evaluationId,
      },
    },
  ])
  await actor(staff, w, "agentonic_admin")
  expect((await command("deploy")).ok).toBe(false)
})
it("local evaluation success cannot unlock production approval", async () => {
  const p = await plan("local")
  await register("local")
  await authorize(p.evaluationId)
  await finish((await evalClaim("local"))!)
  await expect(approve(p)).rejects.toMatchObject({ code: "42501" })
})
it("rejects failed checks even when the worker submits otherwise valid answers", async () => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  await finish((await evalClaim())!, false)
  await expect(approve(p)).rejects.toMatchObject({ code: "42501" })
})
it("cannot authorize another member's plan or substitute its dataset hash", async () => {
  const p = await plan()
  await actor(other, otherW)
  await expect(
    evalCommand("authorize", {
      evaluationId: p.evaluationId,
      datasetHash: "a".repeat(64),
      consent: true,
    })
  ).rejects.toMatchObject({ code: "42501" })
  await actor()
  await expect(
    evalCommand("authorize", {
      evaluationId: p.evaluationId,
      datasetHash: "a".repeat(64),
      consent: true,
    })
  ).rejects.toMatchObject({ code: "42501" })
})
it("preserves provider commitments across consent cancellation and rejects the stale lease", async () => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=25000000,committed_microusd=1000 WHERE provider='openai'"
  )
  const job = (await evalClaim())!
  expect(
    await execute(job, "reserve", {
      id: id(800),
      provider: "openai",
      model: "gpt-4.1-mini-2025-04-14",
      microusd: 2000,
    })
  ).toMatchObject({ ok: true })
  await actor()
  await evalCommand("cancel", { evaluationId: p.evaluationId })
  await db.exec("RESET ROLE; SET LOCAL ROLE agentonic_eval_azure")
  await expect(execute(job, "context")).rejects.toMatchObject({ code: "42501" })
  expect(
    (
      await sql(
        "SELECT committed_microusd::int n FROM agentonic.retrieval_provider_budgets WHERE provider='openai'"
      )
    ).rows
  ).toEqual([{ n: 3000 }])
})
it("denies approval after source deletion or worker revocation", async () => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  await finish((await evalClaim())!)
  await sql("UPDATE agentonic.evaluation_workers SET revoked_at=now()")
  await expect(approve(p)).rejects.toMatchObject({ code: "42501" })
})
it.each([
  ["source deletion", "UPDATE agentonic.documents SET deleted_at=now()"],
  ["code revocation", "UPDATE agentonic.code_releases SET revoked_at=now()"],
  [
    "grant revocation",
    "UPDATE agentonic.support_access_grants SET revoked_at=now()",
  ],
  ["staff downgrade", "UPDATE agentonic.platform_staff SET role='support'"],
])("blocks approval after %s", async (_reason, mutation) => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  await finish((await evalClaim())!)
  await sql(mutation)
  await expect(approve(p)).rejects.toMatchObject({ code: "42501" })
})
it("keeps approval validity separate from status and invalidates it on revocation", async () => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  await finish((await evalClaim())!)
  const decision = await approve(p)
  expect(
    (
      await sql("SELECT agentonic.version_approval_valid($1) valid", [
        decision.id,
      ])
    ).rows
  ).toEqual([{ valid: true }])
  await actor(staff, w, "agentonic_admin")
  await evalCommand("revoke", {
    submissionId: p.submissionId,
    feedback: "Synthetic revocation after review.",
  })
  expect(
    (
      await sql("SELECT agentonic.version_approval_valid($1) valid", [
        decision.id,
      ])
    ).rows
  ).toEqual([{ valid: false }])
})
it("fences lost leases without retrying paid work", async () => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  const job = (await evalClaim())!
  await sql(
    "UPDATE agentonic.evaluation_runs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [job.id]
  )
  expect(await evalClaim()).toBeNull()
  await expect(execute(job, "read")).rejects.toMatchObject({ code: "42501" })
  expect(
    (
      await sql("SELECT status FROM agentonic.evaluation_runs WHERE id=$1", [
        job.id,
      ])
    ).rows
  ).toEqual([{ status: "error" }])
})
it("enforces run caps, settles once and retains unknown reservations", async () => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=25000000 WHERE provider='openai'"
  )
  const job = (await evalClaim())!
  const reserve = {
    id: id(801),
    provider: "openai",
    model: "gpt-4.1-mini-2025-04-14",
    microusd: 200000,
  }
  expect(await execute(job, "reserve", reserve)).toMatchObject({ ok: true })
  expect(
    await execute(job, "reserve", { ...reserve, id: id(802) })
  ).toMatchObject({ ok: false, code: "budget_exhausted" })
  await execute(job, "search", { embedding })
  const context = await execute(job, "context")
  await expect(
    execute(job, "answer", {
      text: "three years",
      citations: (context.passages as { id: string }[]).map((p) => p.id),
      insufficientEvidence: false,
      model: reserve.model,
    })
  ).rejects.toMatchObject({ code: "42501" })
  const settlement = {
    id: reserve.id,
    microusd: 1000,
    tokens: 100,
    outputTokens: 10,
  }
  await execute(job, "settle", settlement)
  await expect(execute(job, "settle", settlement)).rejects.toMatchObject({
    code: "42501",
  })
  expect(
    (
      await sql(
        "SELECT committed_microusd::int n FROM agentonic.evaluation_runs WHERE id=$1",
        [job.id]
      )
    ).rows
  ).toEqual([{ n: 1000 }])
})
it("freezes datasets and worker attestations and requires explicit human review", async () => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  await finish((await evalClaim())!)
  await sql("SAVEPOINT immutable_test")
  await expect(
    db.exec(
      "UPDATE agentonic.evaluation_workers SET verified_at=clock_timestamp()+interval '1 day'"
    )
  ).rejects.toThrow("Immutable worker")
  await db.exec("ROLLBACK TO SAVEPOINT immutable_test")
  await expect(
    db.exec("UPDATE agentonic.evaluation_runs SET budget_usd=1")
  ).rejects.toThrow("Immutable evaluation")
  await db.exec("ROLLBACK TO SAVEPOINT immutable_test")
  const evidence = (
    await db.query<{ evidence_sha256: string }>(
      "SELECT evidence_sha256 FROM agentonic.evaluation_runs WHERE id=$1",
      [p.evaluationId]
    )
  ).rows[0]!.evidence_sha256
  await actor(staff, w, "agentonic_admin")
  await expect(
    evalCommand("approve", {
      evaluationId: p.evaluationId,
      grantId: p.grantId,
      evidenceHash: evidence,
      reviewed: false,
      feedback: "Synthetic review conclusion.",
    })
  ).rejects.toMatchObject({ code: "42501" })
  await expect(
    evalCommand("approve", {
      evaluationId: p.evaluationId,
      grantId: p.grantId,
      evidenceHash: "a".repeat(64),
      reviewed: true,
      feedback: "Synthetic review conclusion.",
    })
  ).rejects.toMatchObject({ code: "42501" })
})
it("hides prior answers immediately when the customer revokes consent", async () => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  await finish((await evalClaim())!)
  await actor()
  const list = async () =>
    (
      await db.query<{ result: { results: unknown[] }[] }>(
        "SELECT agentonic.evaluation_list($1) result",
        [a]
      )
    ).rows[0]!.result
  expect((await list())[0]!.results).toHaveLength(3)
  await evalCommand("cancel", { evaluationId: p.evaluationId })
  expect((await list())[0]!.results).toHaveLength(0)
  await expect(approve(p)).rejects.toMatchObject({ code: "42501" })
})

it("erases cancelled evaluation content while retaining evidence and cost metadata", async () => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  await finish((await evalClaim())!)
  await actor()
  await evalCommand("cancel", { evaluationId: p.evaluationId })
  expect(await evalClaim()).toBeNull()
  expect(
    (
      await sql(
        "SELECT dataset_snapshot,evidence_sha256 IS NOT NULL evidence,scrubbed_at IS NOT NULL scrubbed FROM agentonic.evaluation_runs WHERE id=$1",
        [p.evaluationId]
      )
    ).rows
  ).toEqual([{ dataset_snapshot: [], evidence: true, scrubbed: true }])
  expect(
    (
      await sql(
        "SELECT count(*)::int n FROM agentonic.evaluation_results WHERE evaluation_run_id=$1 AND answer='' AND citations='[]' AND outcome='passed'",
        [p.evaluationId]
      )
    ).rows
  ).toEqual([{ n: 3 }])
})

async function flow(operation: string, payload: Record<string, unknown>) {
  await db.exec("SAVEPOINT flow")
  try {
    const r = await db.query<{ result: Record<string, unknown> }>(
      "SELECT agentonic.review_flow_command($1,$2,$3) result",
      [operation, JSON.stringify(payload), id(910)]
    )
    await db.exec("RELEASE SAVEPOINT flow")
    return r.rows[0]!.result
  } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT flow;RELEASE SAVEPOINT flow")
    throw e
  }
}
async function prepWorker(
  job: Job,
  operation: string,
  payload: Record<string, unknown> = {}
) {
  await db.exec(
    "RESET ROLE;SET LOCAL ROLE agentonic_eval_azure;SAVEPOINT prep_worker"
  )
  try {
    const r = await db.query<{ result: Record<string, unknown> }>(
      "SELECT agentonic.review_preparation_worker($1,$2,$3,$4) result",
      [operation, job.id, job.token, JSON.stringify(payload)]
    )
    await db.exec("RELEASE SAVEPOINT prep_worker")
    return r.rows[0]!.result
  } catch (e) {
    await db.exec(
      "ROLLBACK TO SAVEPOINT prep_worker;RELEASE SAVEPOINT prep_worker"
    )
    throw e
  }
}
async function prepareFlow(risk = "routine") {
  const old = await plan()
  await evalCommand("cancel", { evaluationId: old.evaluationId })
  await sql(
    "INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,runtime_sha256,verified_at,verification) VALUES('agentonic_eval_azure','azure_staging',repeat('d',64),repeat('b',64),now(),'{\"reviewProtocol\":2,\"isolation\":true,\"recovery\":true,\"artifactIntegrity\":true}')"
  )
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=25000000 WHERE provider='openai'"
  )
  await actor()
  const preparation = await flow("prepare", {
    submissionId: old.submissionId,
    budgetUsd: 0.25,
    consent: true,
    requestId: id(912),
  })
  await db.exec("RESET ROLE;SET LOCAL ROLE agentonic_eval_azure")
  const claimed = await db.query<{ result: Job }>(
    "SELECT agentonic.review_preparation_claim(repeat('d',64)) result"
  )
  const job = claimed.rows[0]!.result
  expect(job.id).toBe(preparation.id)
  const input = await prepWorker(job, "read")
  const criteria = [
    {
      key: "duration",
      question: "How long is the warranty?",
      expectedAnswer: "The warranty lasts three years.",
      basis: "Authorized warranty source.",
      sourceIds: (input.sources as { id: string }[]).map((s) => s.id),
      needsInput: false,
      notes: "",
      excluded: false,
      exclusionReason: "",
    },
  ]
  await prepWorker(job, "reserve", {
    id: id(913),
    provider: "openai",
    model: "gpt-4.1-mini-2025-04-14",
    microusd: 50000,
  })
  await prepWorker(job, "settle", {
    id: id(913),
    tokens: 100,
    outputTokens: 50,
    microusd: 500,
  })
  await prepWorker(job, "prepared", { criteria, risk })
  await actor()
  return { ...old, preparationId: job.id, criteria }
}
async function confirmFlow(
  p: Awaited<ReturnType<typeof prepareFlow>>,
  revision = 0
) {
  const current = await sql(
    "SELECT criteria FROM agentonic.evaluation_preparations WHERE id=$1",
    [p.preparationId]
  )
  const criteria = (
    current.rows[0] as { criteria: { excluded: boolean }[] }
  ).criteria.map((c) => ({
    ...c,
    reviewDecision: c.excluded ? "not_applicable" : "approved",
  }))
  await actor()
  expect(
    await flow("save", { preparationId: p.preparationId, revision, criteria })
  ).toMatchObject({ ok: true })
  revision++
  const r = await flow("confirm", {
    preparationId: p.preparationId,
    revision,
    consent: true,
  })
  expect(r.ok).toBe(true)
  return (await evalClaim())!
}

it("requires explicit customer decisions for every situation and preserves them in revisions", async () => {
  const p = await prepareFlow()
  expect(
    await flow("confirm", {
      preparationId: p.preparationId,
      revision: 0,
      consent: true,
    })
  ).toMatchObject({ ok: false, code: "criteria_required" })
  await expect(
    flow("save", {
      preparationId: p.preparationId,
      revision: 0,
      criteria: p.criteria.map((c) => ({
        ...c,
        reviewDecision: "not_applicable",
      })),
    })
  ).rejects.toMatchObject({ code: "42501" })
  expect(
    await flow("save", {
      preparationId: p.preparationId,
      revision: 0,
      criteria: p.criteria.map((c) => ({ ...c, reviewDecision: "approved" })),
    })
  ).toMatchObject({ ok: true })
  expect(
    await flow("save", {
      preparationId: p.preparationId,
      revision: 1,
      criteria: p.criteria.map((c) => ({
        ...c,
        question: "What is the corrected warranty question?",
        reviewDecision: "pending",
      })),
    })
  ).toMatchObject({ ok: true })
  expect(
    await flow("confirm", {
      preparationId: p.preparationId,
      revision: 2,
      consent: true,
    })
  ).toMatchObject({ ok: false, code: "criteria_required" })
  expect(
    (
      await sql(
        "SELECT criteria->0->>'reviewDecision' decision FROM agentonic.evaluation_criteria_revisions WHERE preparation_id=$1 ORDER BY revision",
        [p.preparationId]
      )
    ).rows
  ).toEqual([
    { decision: null },
    { decision: "approved" },
    { decision: "pending" },
  ])
})

it("blocks staff decisions until the customer's evaluation finishes, including direct database calls", async () => {
  const p = await prepareFlow()
  await actor(staff, w, "agentonic_admin")
  const opened = await command("review.open", { submissionId: p.submissionId })
  const payload = {
    submissionId: p.submissionId,
    grantId: opened.data.grantId,
    decision: "changes_requested",
    feedback: "Please improve the synthetic response.",
  }
  expect(await command("review.decide", payload)).toMatchObject({
    ok: false,
    code: "evaluation_required",
  })
  const pending = await db.query<{ result: { canDecide: boolean } }>(
    "SELECT agentonic.review_flow_state($1,$2) result",
    [p.submissionId, opened.data.grantId]
  )
  expect(pending.rows[0]!.result.canDecide).toBe(false)
  const job = await confirmFlow(p)
  await actor(staff, w, "agentonic_admin")
  expect(await command("review.decide", payload)).toMatchObject({
    ok: false,
    code: "evaluation_required",
  })
  await db.exec("RESET ROLE; SET LOCAL ROLE agentonic_eval_azure")
  await finishFlow(job, "needs_changes")
  await actor(staff, w, "agentonic_admin")
  const finished = await db.query<{ result: { canDecide: boolean } }>(
    "SELECT agentonic.review_flow_state($1,$2) result",
    [p.submissionId, opened.data.grantId]
  )
  expect(finished.rows[0]!.result.canDecide).toBe(true)
  expect(await command("review.decide", payload)).toMatchObject({ ok: true })
})
async function finishFlow(
  job: Job,
  verdict = "passed",
  routine = true,
  executionModel = "gpt-4.1-mini-2025-04-14"
) {
  for (let i = 0; i < 3; i++) {
    await execute(job, "search", { embedding })
    const context = await execute(job, "context")
    const grade = await execute(job, "grade-context")
    expect(grade.criterion).toMatchObject({
      kind: i === 0 ? "business" : "platform",
    })
    await execute(job, "answer", {
      text:
        i === 0
          ? "The warranty lasts three years."
          : "No hay evidencia del PIN solicitado.",
      citations:
        i === 0 ? (context.passages as { id: string }[]).map((p) => p.id) : [],
      insufficientEvidence: i !== 0,
      model: executionModel,
      assessment: {
        verdict,
        explanation: "Synthetic grounded comparison.",
        suggestion:
          verdict === "passed" ? "" : "Clarify the requested behavior.",
        grounded: verdict === "passed",
        meetsExpectation: verdict === "passed",
        safe: true,
        routine,
        confidence: verdict === "uncertain" ? "low" : "high",
      },
    })
  }
}

it("does not use an older completed evaluation to bypass a newer pending review", async () => {
  const p = await prepareFlow()
  await finishFlow(await confirmFlow(p), "needs_changes")
  await actor()
  expect(
    await flow("prepare", {
      submissionId: p.submissionId,
      budgetUsd: 0.25,
      consent: true,
      requestId: id(970),
    })
  ).toMatchObject({ ok: true })
  await actor(staff, w, "agentonic_admin")
  const opened = await command("review.open", { submissionId: p.submissionId })
  expect(
    await command("review.decide", {
      submissionId: p.submissionId,
      grantId: opened.data.grantId,
      decision: "rejected",
      feedback: "Synthetic feedback.",
    })
  ).toMatchObject({ ok: false, code: "evaluation_required" })
})
it("persists customer criteria edits and notes, protects provenance and freezes confirmation", async () => {
  const p = await prepareFlow()
  const edited = p.criteria.map((c) => ({
    ...c,
    notes: "Explain the warranty concisely.",
  }))
  expect(
    await flow("save", {
      preparationId: p.preparationId,
      revision: 0,
      criteria: edited,
    })
  ).toMatchObject({ ok: true })
  expect(
    await flow("save", {
      preparationId: p.preparationId,
      revision: 0,
      criteria: edited,
    })
  ).toMatchObject({ ok: false, code: "conflict" })
  await expect(
    flow("save", {
      preparationId: p.preparationId,
      revision: 1,
      criteria: edited.map((c) => ({ ...c, basis: "Forged provenance" })),
    })
  ).rejects.toMatchObject({ code: "42501" })
  const job = await confirmFlow(p, 1)
  await actor()
  await expect(
    flow("save", {
      preparationId: p.preparationId,
      revision: 1,
      criteria: edited,
    })
  ).rejects.toMatchObject({ code: "42501" })
  expect(
    (
      await sql(
        "SELECT revision,criteria->0->>'notes' notes FROM agentonic.evaluation_criteria_revisions WHERE preparation_id=$1 ORDER BY revision",
        [p.preparationId]
      )
    ).rows
  ).toEqual([
    { revision: 0, notes: "" },
    { revision: 1, notes: "Explain the warranty concisely." },
    { revision: 2, notes: "Explain the warranty concisely." },
  ])
  const frozen = await sql(
    "SELECT dataset_snapshot FROM agentonic.evaluation_runs WHERE id=$1",
    [job.id]
  )
  expect(
    (frozen.rows[0] as { dataset_snapshot: unknown[] }).dataset_snapshot
  ).toHaveLength(3)
})
it("automatically approves exact routine evidence with a policy actor, and permits staff revocation", async () => {
  const p = await prepareFlow()
  const job = await confirmFlow(p)
  await finishFlow(job)
  const d = await sql(
    "SELECT id,actor_policy_version,actor_staff_id,assessment_snapshot,agentonic.version_approval_valid(id) valid FROM agentonic.submission_review_decisions WHERE submission_id=$1 AND decision='approved'",
    [p.submissionId]
  )
  expect(d.rows).toMatchObject([
    {
      actor_policy_version: "readonly-review-v1",
      actor_staff_id: null,
      valid: true,
      assessment_snapshot: { humanReviewed: false, evaluated: true },
    },
  ])
  await actor()
  const state = await db.query<{
    result: { preparations: { status: string; results: unknown[] }[] }
  }>("SELECT agentonic.review_flow_state($1) result", [a])
  expect(state.rows[0]!.result.preparations[0]).toMatchObject({
    status: "approved",
  })
  expect(state.rows[0]!.result.preparations[0]!.results).toHaveLength(3)
  await actor(staff, w, "agentonic_admin")
  await evalCommand("revoke", {
    submissionId: p.submissionId,
    feedback: "Synthetic revocation of automatic approval.",
  })
  expect(
    (
      await sql("SELECT agentonic.version_approval_valid($1) valid", [
        (d.rows[0] as { id: string }).id,
      ])
    ).rows
  ).toEqual([{ valid: false }])
})
it.each([
  ["sensitive", "passed", "needs_attention"],
  ["routine", "uncertain", "needs_attention"],
  ["routine", "needs_changes", "needs_changes"],
])(
  "routes %s / %s without automatic approval",
  async (risk, verdict, status) => {
    const p = await prepareFlow(risk)
    await finishFlow(await confirmFlow(p), verdict)
    expect(
      (
        await sql(
          "SELECT status FROM agentonic.evaluation_preparations WHERE id=$1",
          [p.preparationId]
        )
      ).rows
    ).toEqual([{ status }])
    expect(
      (
        await sql(
          "SELECT count(*)::int n FROM agentonic.submission_review_decisions WHERE decision='approved'"
        )
      ).rows
    ).toEqual([{ n: 0 }])
  }
)
it("combines preparation and execution costs and denies ungraded v2 answers", async () => {
  const p = await prepareFlow()
  const job = await confirmFlow(p)
  expect(
    await execute(job, "reserve", {
      id: id(915),
      provider: "openai",
      model: "gpt-4.1-mini-2025-04-14",
      microusd: 250000,
    })
  ).toMatchObject({ ok: false, code: "budget_exhausted" })
  await execute(job, "search", { embedding })
  const context = await execute(job, "context")
  await expect(
    execute(job, "answer", {
      text: "The warranty lasts three years.",
      citations: (context.passages as { id: string }[]).map((p) => p.id),
      insufficientEvidence: false,
      model: "gpt-4.1-mini-2025-04-14",
    })
  ).rejects.toMatchObject({ code: "42501" })
})
it("requires a reason for exclusion, keeps platform checks and routes exclusions to staff", async () => {
  const p = await prepareFlow()
  const extra = {
    ...p.criteria[0]!,
    key: "customer-case",
    basis: "Aportado por el cliente.",
    sourceIds: [],
  }
  await expect(
    flow("save", {
      preparationId: p.preparationId,
      revision: 0,
      criteria: [{ ...p.criteria[0], excluded: true }, extra],
    })
  ).rejects.toMatchObject({ code: "42501" })
  await flow("save", {
    preparationId: p.preparationId,
    revision: 0,
    criteria: [
      {
        ...p.criteria[0],
        excluded: true,
        exclusionReason: "Not relevant for this version.",
      },
      extra,
    ],
  })
  await finishFlow(await confirmFlow(p, 1))
  expect(
    (
      await sql(
        "SELECT status FROM agentonic.evaluation_preparations WHERE id=$1",
        [p.preparationId]
      )
    ).rows
  ).toEqual([{ status: "needs_attention" }])
})
it("cancels and scrubs customer preparation and revisions, preserving usage", async () => {
  const p = await prepareFlow()
  const job = await confirmFlow(p)
  await finishFlow(job)
  await actor()
  await flow("cancel", { preparationId: p.preparationId })
  await evalClaim()
  expect(
    (
      await sql(
        "SELECT criteria,generated_criteria,committed_microusd::int cost FROM agentonic.evaluation_preparations WHERE id=$1",
        [p.preparationId]
      )
    ).rows
  ).toEqual([{ criteria: [], generated_criteria: [], cost: 500 }])
  expect(
    (
      await sql(
        "SELECT count(*)::int n FROM agentonic.evaluation_results WHERE evaluation_run_id=$1 AND assessment IS NULL AND answer=''",
        [job.id]
      )
    ).rows
  ).toEqual([{ n: 3 }])
})
it("denies another customer access to criteria and blocks confirmation after source deletion", async () => {
  const p = await prepareFlow()
  await actor(other, otherW)
  await expect(
    flow("save", {
      preparationId: p.preparationId,
      revision: 0,
      criteria: p.criteria,
    })
  ).rejects.toMatchObject({ code: "42501" })
  await sql("UPDATE agentonic.documents SET deleted_at=clock_timestamp()")
  await actor()
  await expect(
    flow("confirm", {
      preparationId: p.preparationId,
      revision: 0,
      consent: true,
    })
  ).rejects.toMatchObject({ code: "42501" })
  const state = await db.query<{
    result: { preparations: { criteria: unknown[]; sources: unknown[] }[] }
  }>("SELECT agentonic.review_flow_state($1) result", [a])
  expect(state.rows[0]!.result.preparations[0]).toMatchObject({
    criteria: [],
    sources: [],
  })
})
it("requires customer business input before confirmation", async () => {
  const p = await prepareFlow()
  await flow("save", {
    preparationId: p.preparationId,
    revision: 0,
    criteria: p.criteria.map((c) => ({
      ...c,
      expectedAnswer: "",
      needsInput: true,
    })),
  })
  expect(
    await flow("confirm", {
      preparationId: p.preparationId,
      revision: 1,
      consent: true,
    })
  ).toMatchObject({ ok: false, code: "criteria_required" })
})

it("accepts grounded customer abstention without fabricated citations", async () => {
  const p = await prepareFlow()
  await flow("save", {
    preparationId: p.preparationId,
    revision: 0,
    criteria: p.criteria.map((c) => ({
      ...c,
      question: "What limitations apply to this warranty?",
      expectedAnswer:
        "There is insufficient evidence about warranty limitations.",
    })),
  })
  const job = await confirmFlow(p, 1)
  await execute(job, "search", { embedding })
  await execute(job, "answer", {
    text: "There is insufficient evidence about warranty limitations.",
    citations: [],
    insufficientEvidence: true,
    model: "gpt-4.1-mini-2025-04-14",
    assessment: {
      verdict: "passed",
      explanation: "The source only gives duration, not limitations.",
      suggestion: "",
      grounded: true,
      meetsExpectation: true,
      safe: true,
      routine: true,
      confidence: "high",
    },
  })
  expect(
    (
      await sql(
        "SELECT outcome,checks->>'citations' citations FROM agentonic.evaluation_results WHERE evaluation_run_id=$1",
        [job.id]
      )
    ).rows
  ).toEqual([{ outcome: "passed", citations: "true" }])
})
it("shows manual exception approval as approved in the customer outcome", async () => {
  const p = await prepareFlow("sensitive")
  const job = await confirmFlow(p)
  await finishFlow(job)
  await approve({ ...p, evaluationId: job.id })
  await actor()
  const result = await db.query<{
    result: { preparations: { status: string }[] }
  }>("SELECT agentonic.review_flow_state($1) result", [a])
  expect(result.rows[0]!.result.preparations[0]!.status).toBe("approved")
})

it("scopes review summary identity and immutable comparison text to live authorization", async () => {
  const p = await prepareFlow()
  const edited = p.criteria.map((c) => ({
    ...c,
    question: "What warranty duration is documented?",
    notes: "Synthetic clarification.",
    reviewDecision: "approved",
  }))
  await flow("save", {
    preparationId: p.preparationId,
    revision: 0,
    criteria: edited,
  })
  async function state(target = a, grant: string | null = null) {
    const result = await db.query<{
      result: {
        preparations: Array<{
          agentName: string | null
          versionNumber: number | null
          originalCriteria: unknown[]
          criteria: unknown[]
        }>
      }
    }>("SELECT agentonic.review_flow_state($1,$2) result", [target, grant])
    return result.rows[0]!.result
  }
  const expectedOriginals = p.criteria.map(
    ({ key, question, expectedAnswer }) => ({ key, question, expectedAnswer })
  )
  expect((await state()).preparations[0]).toMatchObject({
    agentName: "Synthetic agent",
    versionNumber: 1,
    originalCriteria: expectedOriginals,
    criteria: edited,
  })
  await actor(staff, w, "agentonic_admin")
  expect(
    (await state(p.submissionId, p.grantId)).preparations[0]
  ).toMatchObject({
    agentName: "Synthetic agent",
    versionNumber: 1,
    originalCriteria: expectedOriginals,
  })
  await actor(other, otherW)
  await db.exec("SAVEPOINT summary_scope")
  await expect(state()).rejects.toMatchObject({ code: "42501" })
  await db.exec(
    "ROLLBACK TO SAVEPOINT summary_scope; RELEASE SAVEPOINT summary_scope"
  )
  await actor()
  await flow("cancel", { preparationId: p.preparationId })
  expect((await state()).preparations[0]).toMatchObject({
    agentName: null,
    versionNumber: null,
    originalCriteria: [],
    criteria: [],
  })
})

async function receipt(submissionId: string) {
  const read = await db.query<{ result: unknown }>(
    "SELECT agentonic.approved_review_receipt($1::uuid,$2::uuid) result",
    [submissionId, id(998)]
  )
  return read.rows[0]?.result === null
    ? null
    : reviewReceipt.parse(read.rows[0]?.result)
}
it("reads an audited exact-version approved receipt without reopening the review", async () => {
  const p = await prepareFlow()
  await actor(staff, w, "agentonic_admin")
  expect(await receipt(p.submissionId)).toBeNull()
  const job = await confirmFlow(p)
  await finishFlow(job)
  await actor()
  expect(
    (
      await command("draft.save", {
        agentId: a,
        revision: 1,
        content: {
          ...content,
          systemPrompt: "This is a later draft, not the approved version.",
        },
        requestedAccess: requested,
      })
    ).ok
  ).toBe(true)
  await actor(staff, w, "agentonic_admin")
  const result = await receipt(p.submissionId)
  expect(result).toMatchObject({
    id: p.submissionId,
    versionNumber: 1,
    content,
    contentAvailable: true,
    reportAvailable: true,
    approval: { automatic: true, valid: true },
    evaluation: { id: job.id },
  })
  expect(result?.criteria).toHaveLength(1)
  expect(result?.results).toHaveLength(3)
  expect(JSON.stringify(result)).not.toContain('"sources":')
  expect(
    (await command("review.open", { submissionId: p.submissionId })).ok
  ).toBe(false)
  const grants = await sql(
    "SELECT id FROM agentonic.support_access_grants WHERE scope->>'version'='3'"
  )
  expect(grants.rows).toHaveLength(1)
  await actor(staff, w, "agentonic_admin")
  await receipt(p.submissionId)
  expect(
    (
      await sql(
        "SELECT id FROM agentonic.support_access_grants WHERE scope->>'version'='3'"
      )
    ).rows
  ).toHaveLength(1)
  expect(
    (
      await sql(
        "SELECT action FROM agentonic.audit_events WHERE action='review.receipt.read' AND support_access_grant_id=$1",
        [(grants.rows[0] as { id: string }).id]
      )
    ).rows
  ).toHaveLength(2)
  await actor(staff, otherW, "agentonic_admin")
  expect(await receipt(p.submissionId)).toBeNull()
  await actor()
  await db.exec("SAVEPOINT denied_receipt")
  await expect(receipt(p.submissionId)).rejects.toThrow()
  await db.exec("ROLLBACK TO SAVEPOINT denied_receipt")
  await sql(
    "UPDATE agentonic.platform_staff SET disabled_at=clock_timestamp() WHERE id=$1",
    [staff]
  )
  await actor(staff, w, "agentonic_admin")
  await db.exec("SAVEPOINT denied_staff_receipt")
  await expect(receipt(p.submissionId)).rejects.toThrow()
  await db.exec("ROLLBACK TO SAVEPOINT denied_staff_receipt")
})
it("redacts receipt evidence on consent revocation and denies revoked submission receipts", async () => {
  const p = await prepareFlow()
  await finishFlow(await confirmFlow(p))
  await actor(staff, w, "agentonic_admin")
  expect((await receipt(p.submissionId))?.reportAvailable).toBe(true)
  await actor()
  expect((await flow("cancel", { preparationId: p.preparationId })).ok).toBe(
    true
  )
  await actor(staff, w, "agentonic_admin")
  expect(await receipt(p.submissionId)).toMatchObject({
    contentAvailable: true,
    reportAvailable: false,
    criteria: [],
    results: [],
    approval: { valid: false },
  })
  await sql(
    "UPDATE agentonic.support_access_grants SET revoked_at=clock_timestamp() WHERE scope->>'version'='3'"
  )
  await actor(staff, w, "agentonic_admin")
  expect(await receipt(p.submissionId)).toMatchObject({
    contentAvailable: false,
    content: null,
    note: null,
    collections: [],
    approval: { feedback: null },
  })
  expect(
    (
      await evalCommand("revoke", {
        submissionId: p.submissionId,
        feedback: "Revoke this synthetic approved receipt.",
      })
    ).ok
  ).toBe(true)
  expect(await receipt(p.submissionId)).toBeNull()
})
it("supports manually approved receipts and hides private content after consent expiry", async () => {
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  await finish((await evalClaim())!)
  expect((await approve(p)).ok).toBe(true)
  expect(await receipt(p.submissionId)).toMatchObject({
    content,
    reportAvailable: true,
    approval: { automatic: false, reviewerName: "Staff" },
  })
  // Simulate passage of time without mutating frozen consent or production records.
  await sql("ALTER TABLE agentonic.agent_submissions DISABLE TRIGGER USER")
  await sql(
    "UPDATE agentonic.agent_submissions SET review_consent=jsonb_set(review_consent,'{expiresAt}',to_jsonb((clock_timestamp()-interval '1 second')::text)) WHERE id=$1",
    [p.submissionId]
  )
  await sql("ALTER TABLE agentonic.agent_submissions ENABLE TRIGGER USER")
  await actor(staff, w, "agentonic_admin")
  expect(await receipt(p.submissionId)).toMatchObject({
    contentAvailable: false,
    reportAvailable: false,
    content: null,
    criteria: [],
    results: [],
    approval: { valid: false },
  })
})

async function lifecycleCall(
  fn: string,
  operation: string,
  payload: Record<string, unknown>
) {
  await db.exec("SAVEPOINT lifecycle")
  try {
    const r = await db.query<{ result: Record<string, unknown> }>(
      `SELECT agentonic.${fn}($1,$2,$3) result`,
      [operation, JSON.stringify(payload), id(991)]
    )
    await db.exec("RELEASE SAVEPOINT lifecycle")
    return r.rows[0]!.result
  } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT lifecycle;RELEASE SAVEPOINT lifecycle")
    throw e
  }
}
async function approvedStaging() {
  const p = await prepareFlow()
  const evaluated = await confirmFlow(p)
  await finishFlow(evaluated)
  if (requested.tools.length)
    await approve({ ...p, evaluationId: evaluated.id })
  await sql(
    "INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,runtime_sha256,verified_at,heartbeat_at) VALUES('local','agentonic_deployer_local',repeat('f',64),repeat('b',64),clock_timestamp(),clock_timestamp())"
  )
  await actor()
  const d = await lifecycleCall("deployment_command", "authorize", {
    submissionId: p.submissionId,
    environment: "local",
    budgetUsd: 0.25,
    consent: true,
    requestId: id(980),
  })
  expect(d.ok).toBe(true)
  return { ...p, deploymentId: String(d.id) }
}
const serviceSecret = "a".repeat(64)
async function hostCall(operation: string, deploymentId: string | null = null) {
  await db.exec("RESET ROLE;SET LOCAL ROLE agentonic_deployer_local")
  const r = await db.query<{ result: Record<string, unknown> }>(
    "SELECT agentonic.deployment_host($1,$2,jsonb_build_object('brokerHash',repeat('f',64),'tokenHash',encode(sha256(convert_to($3,'UTF8')),'hex'))) result",
    [operation, deploymentId, serviceSecret]
  )
  return r.rows[0]!.result
}
async function readyStaging(p: Awaited<ReturnType<typeof approvedStaging>>) {
  await actor(staff, w, "agentonic_admin")
  expect(
    (
      await lifecycleCall("deployment_command", "activate", {
        deploymentId: p.deploymentId,
      })
    ).ok
  ).toBe(true)
  const prepared = await hostCall("prepare", p.deploymentId)
  await db.exec("RESET ROLE;SET LOCAL ROLE agentonic_runtime_local")
  const result = await db.query<{ result: { ok: boolean } }>(
    "SELECT agentonic.deployment_service('ready',$1,$2,$3) result",
    [
      p.deploymentId,
      serviceSecret,
      JSON.stringify({ manifestHash: prepared.manifestHash }),
    ]
  )
  expect(result.rows[0]!.result.ok).toBe(true)
}
async function chat(operation: string, payload: Record<string, unknown>) {
  const r = await db.query<{ result: Record<string, unknown> }>(
    "SELECT agentonic.staging_chat($1,$2) result",
    [operation, JSON.stringify(payload)]
  )
  return r.rows[0]!.result
}
async function stagingWork(
  dep: string,
  operation: string,
  job: Job | null = null,
  payload: Record<string, unknown> = {}
) {
  await db.exec(
    "RESET ROLE;SET LOCAL ROLE agentonic_runtime_local;SAVEPOINT staging_worker"
  )
  try {
    const r = await db.query<{ result: Record<string, unknown> }>(
      "SELECT agentonic.staging_worker($1,$2,$3,$4,$5,$6) result",
      [
        operation,
        dep,
        serviceSecret,
        job?.id ?? null,
        job?.token ?? null,
        JSON.stringify(payload),
      ]
    )
    await db.exec("RELEASE SAVEPOINT staging_worker")
    return r.rows[0]!.result
  } catch (e) {
    await db.exec(
      "ROLLBACK TO SAVEPOINT staging_worker;RELEASE SAVEPOINT staging_worker"
    )
    throw e
  }
}
it("requires customer consent and current approval before staff can activate staging", async () => {
  const p = await approvedStaging()
  await expect(
    lifecycleCall("deployment_command", "activate", {
      deploymentId: p.deploymentId,
    })
  ).rejects.toMatchObject({ code: "42501" })
  await actor(other, otherW)
  await expect(
    lifecycleCall("deployment_command", "authorize", {
      submissionId: p.submissionId,
      environment: "local",
      budgetUsd: 0.25,
      consent: true,
      requestId: id(981),
    })
  ).rejects.toMatchObject({ code: "42501" })
  await actor(staff, w, "agentonic_admin")
  const state = await db.query<{ result: { deployments: unknown[] } }>(
    "SELECT agentonic.lifecycle_state($1) result",
    [p.submissionId]
  )
  expect(state.rows[0]!.result.deployments).toMatchObject([
    { status: "awaiting_activation", canActivate: true, online: false },
  ])
  await readyStaging(p)
  await actor()
  const c = await chat("start", {
    deploymentId: p.deploymentId,
    title: "Synthetic staging chat",
  })
  expect(c.ok).toBe(true)
  await actor(other, otherW)
  expect((await chat("state", { conversationId: c.id })).ok).toBe(false)
})
it("separates activation expiry from ongoing staging consent and rechecks source rights", async () => {
  const p = await approvedStaging()
  await readyStaging(p)
  // Passage of the activation deadline, without mutating immutable approval scope.
  await sql(
    "ALTER TABLE agentonic.submission_review_decisions DISABLE TRIGGER USER"
  )
  await sql(
    "UPDATE agentonic.submission_review_decisions SET created_at=clock_timestamp()-interval '2 days',approval_expires_at=clock_timestamp()-interval '1 second' WHERE submission_id=$1 AND decision='approved'",
    [p.submissionId]
  )
  await sql(
    "ALTER TABLE agentonic.submission_review_decisions ENABLE TRIGGER USER"
  )
  const authorized = await sql(
    "SELECT agentonic.deployment_authorized(d) valid FROM agentonic.deployments d WHERE id=$1",
    [p.deploymentId]
  )
  expect(authorized.rows[0]).toMatchObject({ valid: true })
  await actor()
  const c = await chat("start", {
    deploymentId: p.deploymentId,
    title: "Live consent",
  })
  expect(c.ok).toBe(true)
  await sql(
    "UPDATE agentonic.knowledge_sources SET configuration='{\"revoked\":true}' WHERE collection_id=$1",
    [collection]
  )
  await actor()
  expect((await chat("state", { conversationId: c.id })).ok).toBe(false)
  await hostCall("poll")
  expect(
    (
      await sql("SELECT status FROM agentonic.deployments WHERE id=$1", [
        p.deploymentId,
      ])
    ).rows[0]
  ).toMatchObject({ status: "stopped" })
})
it("denies stale approval at activation and never marks an unverified installation running", async () => {
  const p = await approvedStaging()
  await actor(staff, w, "agentonic_admin")
  await lifecycleCall("deployment_command", "activate", {
    deploymentId: p.deploymentId,
  })
  const prepared = await hostCall("prepare", p.deploymentId)
  expect(prepared.manifest).toMatchObject({
    configurationId: p.candidateId,
    deploymentId: p.deploymentId,
  })
  await sql(
    "ALTER TABLE agentonic.submission_review_decisions DISABLE TRIGGER USER"
  )
  await sql(
    "UPDATE agentonic.submission_review_decisions SET created_at=clock_timestamp()-interval '2 days',approval_expires_at=clock_timestamp()-interval '1 second' WHERE submission_id=$1 AND decision='approved'",
    [p.submissionId]
  )
  await sql(
    "ALTER TABLE agentonic.submission_review_decisions ENABLE TRIGGER USER"
  )
  await db.exec("RESET ROLE;SET LOCAL ROLE agentonic_runtime_local")
  const result = await db.query<{ result: { ok: boolean } }>(
    "SELECT agentonic.deployment_service('ready',$1,$2,$3) result",
    [
      p.deploymentId,
      serviceSecret,
      JSON.stringify({ manifestHash: prepared.manifestHash }),
    ]
  )
  expect(result.rows[0]!.result.ok).toBe(false)
  expect(
    (
      await sql("SELECT status FROM agentonic.deployments WHERE id=$1", [
        p.deploymentId,
      ])
    ).rows[0]
  ).toMatchObject({ status: "preparing" })
})
it("serializes private chat, validates citations, settles usage once and fences failed leases", async () => {
  const p = await approvedStaging()
  await readyStaging(p)
  await actor()
  const listing = await db.query<{
    result: { configuration: { liveVersion: string } }[]
  }>("SELECT agentonic.agent_listing() result")
  expect(listing.rows[0]!.result[0]!.configuration.liveVersion).toContain(
    "Pruebas locales"
  )
  const c = await chat("start", {
    deploymentId: p.deploymentId,
    title: "Synthetic answers",
  })
  const payload = {
    conversationId: c.id,
    query: "How long is the warranty?",
    requestId: id(982),
  }
  const first = await chat("turn", payload)
  expect(await chat("turn", payload)).toEqual(first)
  expect((await chat("turn", { ...payload, requestId: id(983) })).code).toBe(
    "busy"
  )
  const job = (await stagingWork(p.deploymentId, "claim")) as unknown as Job
  await stagingWork(p.deploymentId, "reserve", job, {
    id: id(984),
    provider: "openai",
    model: "gpt-4.1-mini-2025-04-14",
    microusd: 1000,
  })
  await stagingWork(p.deploymentId, "settle", job, {
    id: id(984),
    tokens: 100,
    microusd: 500,
  })
  await expect(
    stagingWork(p.deploymentId, "settle", job, {
      id: id(984),
      tokens: 100,
      microusd: 500,
    })
  ).rejects.toMatchObject({ code: "42501" })
  await stagingWork(p.deploymentId, "search", job, { embedding })
  await db.exec("RESET ROLE")
  await sql(
    "INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd) VALUES($1,$2,$3,'openai','gpt-4.1-mini-2025-04-14',1000)",
    [id(990), id(991), w]
  )
  await expect(
    stagingWork(p.deploymentId, "settle", job, {
      id: id(990),
      tokens: 1,
      microusd: 1,
    })
  ).rejects.toMatchObject({ code: "42501" })
  const context = await stagingWork(p.deploymentId, "context", job)
  expect(JSON.parse(String(context.configurationJson))).toEqual(content)
  await expect(
    stagingWork(p.deploymentId, "answer", job, {
      text: "three years",
      citations: [id(998)],
      insufficientEvidence: false,
      model: "gpt-4.1-mini-2025-04-14",
    })
  ).rejects.toMatchObject({ code: "42501" })
  await stagingWork(p.deploymentId, "answer", job, {
    text: "three years",
    citations: (context.passages as { id: string }[]).map((x) => x.id),
    insufficientEvidence: false,
    model: "gpt-4.1-mini-2025-04-14",
  })
  await actor()
  expect(await chat("state", { conversationId: c.id })).toMatchObject({
    ok: true,
    committedMicrousd: 500,
    turns: [{ answer: "three years", status: "succeeded" }],
  })
  await chat("turn", { ...payload, requestId: id(983) })
  const lost = (await stagingWork(p.deploymentId, "claim")) as unknown as Job
  await stagingWork(p.deploymentId, "reserve", lost, {
    id: id(985),
    provider: "openai",
    model: "gpt-4.1-mini-2025-04-14",
    microusd: 1000,
  })
  await sql(
    "UPDATE agentonic.staging_turns SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [lost.id]
  )
  expect(await stagingWork(p.deploymentId, "claim")).toBeNull()
  await expect(
    stagingWork(p.deploymentId, "answer", lost, {})
  ).rejects.toMatchObject({ code: "42501" })
  expect(
    (
      await sql(
        "SELECT committed_microusd FROM agentonic.deployments WHERE id=$1",
        [p.deploymentId]
      )
    ).rows[0]
  ).toMatchObject({ committed_microusd: 1500 })
  await actor(staff, w, "agentonic_admin")
  await lifecycleCall("deployment_command", "stop", {
    deploymentId: p.deploymentId,
  })
  await hostCall("poll")
  expect(
    (
      await sql(
        "SELECT count(*)::int n FROM agentonic.staging_turns WHERE conversation_id=$1 AND scrubbed_at IS NULL",
        [c.id]
      )
    ).rows[0]
  ).toMatchObject({ n: 0 })
  expect(
    (
      await sql(
        "SELECT committed_microusd FROM agentonic.deployments WHERE id=$1",
        [p.deploymentId]
      )
    ).rows[0]
  ).toMatchObject({ committed_microusd: 1500 })
})
it("renews an expired approval as a new review of the exact same version and retains earlier costs", async () => {
  const p = await approvedStaging()
  await sql(
    "ALTER TABLE agentonic.submission_review_decisions DISABLE TRIGGER USER"
  )
  await sql(
    "UPDATE agentonic.submission_review_decisions SET created_at=clock_timestamp()-interval '2 days',approval_expires_at=clock_timestamp()-interval '1 second' WHERE submission_id=$1 AND decision='approved'",
    [p.submissionId]
  )
  await sql(
    "ALTER TABLE agentonic.submission_review_decisions ENABLE TRIGGER USER"
  )
  await actor(staff, w, "agentonic_admin")
  expect(
    (
      await lifecycleCall("approval_renewal", "request", {
        submissionId: p.submissionId,
      })
    ).ok
  ).toBe(true)
  await actor()
  const payload = {
    submissionId: p.submissionId,
    budgetUsd: 0.25,
    consent: true,
    requestId: id(990),
  }
  const renewed = await lifecycleCall("approval_renewal", "renew", payload)
  expect(renewed.ok).toBe(true)
  expect(renewed.id).not.toBe(p.submissionId)
  expect(await lifecycleCall("approval_renewal", "renew", payload)).toEqual(
    renewed
  )
  const rows = await sql(
    "SELECT configuration_release_id,status,renewed_from_submission_id FROM agentonic.agent_submissions ORDER BY submission_number"
  )
  expect(rows.rows).toMatchObject([
    {
      configuration_release_id: p.candidateId,
      status: "approved",
      renewed_from_submission_id: null,
    },
    {
      configuration_release_id: p.candidateId,
      status: "submitted",
      renewed_from_submission_id: p.submissionId,
    },
  ])
  expect(
    (
      await sql(
        "SELECT committed_microusd FROM agentonic.evaluation_preparations WHERE id=$1",
        [p.preparationId]
      )
    ).rows[0]
  ).toMatchObject({ committed_microusd: 500 })
})

it("rechecks the initiating staff authority when a queued installation becomes ready", async () => {
  const p = await approvedStaging()
  await actor(staff, w, "agentonic_admin")
  await lifecycleCall("deployment_command", "activate", {
    deploymentId: p.deploymentId,
  })
  const prepared = await hostCall("prepare", p.deploymentId)
  await sql("UPDATE agentonic.platform_staff SET role='support' WHERE id=$1", [
    staff,
  ])
  await db.exec("RESET ROLE;SET LOCAL ROLE agentonic_runtime_local")
  const r = await db.query<{ result: { ok: boolean } }>(
    "SELECT agentonic.deployment_service('ready',$1,$2,$3) result",
    [
      p.deploymentId,
      serviceSecret,
      JSON.stringify({ manifestHash: prepared.manifestHash }),
    ]
  )
  expect(r.rows[0]!.result.ok).toBe(false)
})

it("bounds staging context to the frozen runtime's nine completed history turns", async () => {
  const p = await approvedStaging()
  await readyStaging(p)
  await actor()
  const c = await chat("start", {
    deploymentId: p.deploymentId,
    title: "Synthetic history",
  })
  await db.exec("RESET ROLE")
  for (let number = 1; number <= 10; number++)
    await sql(
      "INSERT INTO agentonic.staging_turns(workspace_id,conversation_id,request_id,number,query,answer,status,created_at) VALUES($1,$2,$3,$4,$5,'Synthetic answer','succeeded',clock_timestamp()-interval '10 minutes')",
      [w, c.id, id(1100 + number), number, `Synthetic question ${number}`]
    )
  await actor()
  await chat("turn", {
    conversationId: c.id,
    query: "Next question",
    requestId: id(1120),
  })
  const job = (await stagingWork(p.deploymentId, "claim")) as unknown as Job
  const context = await stagingWork(p.deploymentId, "context", job)
  expect(context.history).toHaveLength(9)
  expect((context.history as { query: string }[])[0]!.query).toBe(
    "Synthetic question 2"
  )
})

it("uses metered, reauthorized ranking for evaluation cases", async () => {
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=100000 WHERE provider='voyage'"
  )
  const p = await plan()
  await register()
  await authorize(p.evaluationId)
  const job = (await evalClaim())!
  await execute(job, "search", { embedding, rerank: true })
  const candidates = (await execute(job, "rerank-context")) as {
    passages: { id: string }[]
  }
  expect(candidates.passages.length).toBeGreaterThan(0)
  expect(
    await execute(job, "reserve", {
      id: id(870),
      provider: "voyage",
      model: "rerank-2.5-lite",
      microusd: 100,
    })
  ).toEqual({ ok: true })
  await expect(
    execute(job, "select-matches", {
      ids: candidates.passages.map((p) => p.id),
    })
  ).rejects.toMatchObject({ code: "42501" })
  await execute(job, "settle", { id: id(870), tokens: 100, microusd: 2 })
  await expect(
    execute(job, "select-matches", { ids: [id(999)] })
  ).rejects.toMatchObject({ code: "42501" })
  await execute(job, "select-matches", {
    ids: candidates.passages.map((p) => p.id),
  })
  expect((await execute(job, "context")).passages).toEqual(candidates.passages)
})

it("uses the same candidate selection and metering contract for deployed chats", async () => {
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=100000 WHERE provider='voyage'"
  )
  const p = await approvedStaging()
  await readyStaging(p)
  await actor()
  const conversation = await chat("start", {
    deploymentId: p.deploymentId,
    title: "Synthetic ranking",
  })
  await chat("turn", {
    conversationId: conversation.id,
    query: "Warranty?",
    requestId: id(871),
  })
  const job = (await stagingWork(p.deploymentId, "claim")) as unknown as Job
  await stagingWork(p.deploymentId, "search", job, { embedding, rerank: true })
  const candidates = (await stagingWork(
    p.deploymentId,
    "rerank-context",
    job
  )) as { passages: { id: string }[] }
  expect(candidates.passages.length).toBeGreaterThan(0)
  await stagingWork(p.deploymentId, "reserve", job, {
    id: id(872),
    provider: "voyage",
    model: "rerank-2.5-lite",
    microusd: 100,
  })
  await stagingWork(p.deploymentId, "settle", job, {
    id: id(872),
    tokens: 100,
    microusd: 2,
  })
  await expect(
    stagingWork(p.deploymentId, "select-matches", job, { ids: [id(999)] })
  ).rejects.toMatchObject({ code: "42501" })
  await stagingWork(p.deploymentId, "select-matches", job, {
    ids: candidates.passages.map((p) => p.id),
  })
  expect((await stagingWork(p.deploymentId, "context", job)).passages).toEqual(
    candidates.passages
  )
})

async function gmailCommand(
  operation: string,
  payload: Record<string, unknown>
) {
  await db.exec("SAVEPOINT gmail")
  try {
    const r = await db.query<{ r: Record<string, unknown> }>(
      "SELECT agentonic.gmail_command($1,$2) r",
      [operation, JSON.stringify(payload)]
    )
    await db.exec("RELEASE SAVEPOINT gmail")
    return r.rows[0]!.r
  } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT gmail; RELEASE SAVEPOINT gmail")
    throw e
  }
}
async function gmailDeployment() {
  await sql(
    "INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext,operations) VALUES($1,$2,$3,$4,'synthetic@example.invalid','opaque','[\"gmail.read\",\"gmail.send\"]')",
    [id(770), w, a, member]
  )
  await actor()
  requested.tools = [
    { connectionId: id(770), operations: ["gmail.read", "gmail.send"] },
  ]
  const deployment = await approvedStaging()
  await readyStaging(deployment)
  await actor()
  const conversation = await chat("start", {
    deploymentId: deployment.deploymentId,
    title: "Synthetic Gmail tools",
  })
  await chat("turn", {
    conversationId: conversation.id,
    requestId: id(771),
    query: "Prepare a synthetic email",
  })
  const job = (await stagingWork(
    deployment.deploymentId,
    "claim"
  )) as unknown as Job
  async function tool(
    operation: string,
    payload: Record<string, unknown> = {}
  ) {
    await db.exec(
      "RESET ROLE; SET LOCAL ROLE agentonic_runtime_local; SAVEPOINT gmail_tool"
    )
    try {
      const r = await db.query<{ r: Record<string, unknown> }>(
        "SELECT agentonic.gmail_staging($1,$2,$3,$4,$5,$6) r",
        [
          operation,
          deployment.deploymentId,
          serviceSecret,
          job.id,
          job.token,
          JSON.stringify(payload),
        ]
      )
      await db.exec("RELEASE SAVEPOINT gmail_tool")
      return r.rows[0]!.r
    } catch (e) {
      await db.exec(
        "ROLLBACK TO SAVEPOINT gmail_tool; RELEASE SAVEPOINT gmail_tool"
      )
      throw e
    }
  }
  return { deployment, conversation, job, tool }
}
it("Gmail freezes exact scope, requires manual review, and claims an unchanged write only once", async () => {
  const p = await gmailDeployment()
  expect((await p.tool("gmail-tools")).tools).toEqual(requested.tools)
  await expect(
    p.tool("gmail-read", {
      connectionId: id(770),
      operation: "gmail.drafts.read",
    })
  ).rejects.toThrow()
  expect(
    await p.tool("gmail-read", {
      connectionId: id(770),
      operation: "gmail.read",
    })
  ).toMatchObject({ credential: "opaque" })
  expect(
    await p.tool("gmail-propose", {
      connectionId: id(770),
      operation: "gmail.send",
      id: id(772),
      argumentsCiphertext: "opaque-message",
      hash: "a".repeat(64),
    })
  ).toMatchObject({ pendingApproval: true })
  await actor(other, otherW)
  await expect(
    gmailCommand("confirm", { id: id(772), hash: "a".repeat(64) })
  ).rejects.toThrow()
  await actor()
  await expect(
    gmailCommand("confirm", { id: id(772), hash: "b".repeat(64) })
  ).rejects.toThrow()
  expect(
    await gmailCommand("confirm", { id: id(772), hash: "a".repeat(64) })
  ).toMatchObject({ operation: "gmail.send" })
  await expect(
    gmailCommand("confirm", { id: id(772), hash: "a".repeat(64) })
  ).rejects.toThrow()
  await gmailCommand("complete", {
    id: id(772),
    status: "uncertain",
    result: { code: "uncertain" },
  })
  await expect(
    gmailCommand("confirm", { id: id(772), hash: "a".repeat(64) })
  ).rejects.toThrow()
  expect(
    (
      await sql(
        "SELECT status,arguments_ciphertext FROM agentonic.gmail_invocations WHERE id=$1",
        [id(772)]
      )
    ).rows
  ).toEqual([{ status: "uncertain", arguments_ciphertext: null }])
})
it("Gmail revocation immediately fences leased reads and pending writes", async () => {
  const p = await gmailDeployment()
  await p.tool("gmail-propose", {
    connectionId: id(770),
    operation: "gmail.send",
    id: id(772),
    argumentsCiphertext: "opaque-message",
    hash: "a".repeat(64),
  })
  await actor()
  await gmailCommand("disconnect", { connectionId: id(770) })
  await expect(
    gmailCommand("confirm", { id: id(772), hash: "a".repeat(64) })
  ).rejects.toThrow()
  await expect(
    p.tool("gmail-read", { connectionId: id(770), operation: "gmail.read" })
  ).rejects.toThrow()
  expect(
    (
      await sql(
        "SELECT status,arguments_ciphertext FROM agentonic.gmail_invocations WHERE id=$1",
        [id(772)]
      )
    ).rows
  ).toEqual([{ status: "cancelled", arguments_ciphertext: null }])
})
it("Gmail expiry blocks confirmation and offboarding erases credentials and proposals", async () => {
  const p = await gmailDeployment()
  await p.tool("gmail-propose", {
    connectionId: id(770),
    operation: "gmail.send",
    id: id(772),
    argumentsCiphertext: "opaque-message",
    hash: "a".repeat(64),
  })
  await sql(
    "UPDATE agentonic.gmail_invocations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [id(772)]
  )
  await actor()
  await expect(
    gmailCommand("confirm", { id: id(772), hash: "a".repeat(64) })
  ).rejects.toThrow()
  await sql(
    "UPDATE agentonic.workspace_members SET status='suspended' WHERE id=$1",
    [member]
  )
  expect(
    (
      await sql(
        "SELECT credential_ciphertext,status FROM agentonic.gmail_connections WHERE id=$1",
        [id(770)]
      )
    ).rows
  ).toEqual([{ credential_ciphertext: null, status: "disconnected" }])
  await expect(
    p.tool("gmail-read", { connectionId: id(770), operation: "gmail.read" })
  ).rejects.toThrow()
})

it("meters frozen web tools in staging, rejects the wrong service and fences disabled web", async () => {
  requested.tools = [
    { capability: "web", operations: ["web.search", "web.read"] },
  ]
  const deployment = await approvedStaging()
  await readyStaging(deployment)
  await actor()
  const conversation = await chat("start", {
    deploymentId: deployment.deploymentId,
    title: "Synthetic public web",
  })
  await chat("turn", {
    conversationId: conversation.id,
    requestId: id(801),
    query: "Read public documentation",
  })
  const job = (await stagingWork(
    deployment.deploymentId,
    "claim"
  )) as unknown as Job
  async function web(
    operation: string,
    payload: Record<string, unknown> = {},
    secret = serviceSecret
  ) {
    await db.exec(
      "RESET ROLE;SET LOCAL ROLE agentonic_runtime_local;SAVEPOINT web_staging_test"
    )
    try {
      const result = await db.query<{ r: Record<string, unknown> }>(
        "SELECT agentonic.web_staging($1,$2,$3,$4,$5,$6) r",
        [
          operation,
          deployment.deploymentId,
          secret,
          job.id,
          job.token,
          JSON.stringify(payload),
        ]
      )
      await db.exec("RELEASE SAVEPOINT web_staging_test")
      return result.rows[0]!.r
    } catch (e) {
      await db.exec(
        "ROLLBACK TO SAVEPOINT web_staging_test;RELEASE SAVEPOINT web_staging_test"
      )
      throw e
    }
  }
  expect(await web("web-tools")).toEqual({ enabled: true })
  await expect(web("web-check", {}, "wrong")).rejects.toThrow()
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=100000 WHERE provider='browserbase'"
  )
  expect(
    await web("web-reserve", { id: id(802), operation: "web.read" })
  ).toEqual({ ok: true })
  expect(
    await web("web-settle", { id: id(802), operation: "web.read" })
  ).toEqual({ ok: true })
  const meter = await sql(
    "SELECT actual_microusd FROM agentonic.retrieval_provider_operations WHERE id=$1",
    [id(802)]
  )
  expect(
    Number((meter.rows[0] as { actual_microusd: number }).actual_microusd)
  ).toBe(4000)
  await actor()
  await command("draft.save", {
    agentId: a,
    revision: 1,
    content,
    requestedAccess: { version: 1, collectionIds: [collection], tools: [] },
  })
  await expect(web("web-check")).rejects.toThrow()
})

// Exercise the actual application transaction against the restricted SQL roles.
async function saveReviewDraft(revision = 0) {
  return command("draft.save", {
    agentId: a,
    revision,
    content: {
      ...content,
      systemPrompt:
        "Help organize the synthetic project, explain the available evidence, and clearly identify any missing information.",
    },
    requestedAccess: requested,
  })
}
async function combinedSubmissionFixture() {
  await saveReviewDraft()
  const frozen = await command("candidate.freeze", {
    agentId: a,
    revision: 1,
    codeReleaseId: code,
  })
  submissionMocks.auth.mockResolvedValue({ authId: owner, email: null })
  submissionMocks.identity.mockImplementation(async (_auth, workspace, run) => {
    await actor(owner, workspace)
    await db.exec("SAVEPOINT combined_submission")
    try {
      submissionMocks.query.mockImplementation(
        async (parts: TemplateStringsArray, ...values: unknown[]) => {
          const query = parts.reduce(
            (text, part, index) => text + (index ? `$${index}` : "") + part,
            ""
          )
          return (await db.query(query, values)).rows
        }
      )
      const result = await run({ $queryRaw: submissionMocks.query })
      await db.exec("RELEASE SAVEPOINT combined_submission")
      return result
    } catch (error) {
      await db.exec(
        "ROLLBACK TO SAVEPOINT combined_submission; RELEASE SAVEPOINT combined_submission"
      )
      throw error
    }
  })
  return {
    candidateId: frozen.id,
    revision: 1,
    note: "Synthetic review",
    consent: true,
    budgetUsd: 0.25,
    requestId: id(987),
  }
}

it("submits and queues criteria together without running evaluation or duplicating a retry", async () => {
  const input = await combinedSubmissionFixture()
  const result = await submitAgentForReview(w, a, input)
  expect(result).toMatchObject({
    ok: true,
    href: `/agents/${a}?workspace=${w}&tab=propuestas`,
  })
  const rows = await sql(
    "SELECT s.id,p.status,p.budget_usd,p.evaluation_id FROM agentonic.agent_submissions s JOIN agentonic.evaluation_preparations p ON p.submission_id=s.id WHERE s.agent_id=$1",
    [a]
  )
  expect(rows.rows).toHaveLength(1)
  expect(rows.rows[0]).toMatchObject({ status: "queued", evaluation_id: null })
  expect(Number((rows.rows[0] as { budget_usd: string }).budget_usd)).toBe(0.25)
  expect((await submitAgentForReview(w, a, input)).ok).toBe(false)
  const counts = await sql(
    "SELECT (SELECT count(*)::integer FROM agentonic.agent_submissions WHERE agent_id=$1) submissions, (SELECT count(*)::integer FROM agentonic.evaluation_preparations WHERE agent_id=$1) preparations",
    [a]
  )
  expect(counts.rows[0]).toEqual({ submissions: 1, preparations: 1 })
})

it("rolls back the submission when criteria preparation cannot be queued", async () => {
  const input = await combinedSubmissionFixture()
  // A consumed idempotency key cannot be reused for another submission.
  const first = await command("submission.send", {
    candidateId: input.candidateId,
    note: "",
    consent: true,
  })
  await flow("prepare", {
    submissionId: first.id,
    budgetUsd: 0.25,
    consent: true,
    requestId: input.requestId,
  })
  await db.exec("COMMIT;BEGIN")
  await actor()
  await saveReviewDraft(1)
  const second = await command("candidate.freeze", {
    agentId: a,
    revision: 2,
    codeReleaseId: code,
  })
  expect(
    (
      await submitAgentForReview(w, a, {
        ...input,
        candidateId: second.id,
        revision: 2,
      })
    ).ok
  ).toBe(false)
  expect(submissionMocks.query.mock.calls.at(-1)?.[0].join("")).toContain(
    "review_flow_command"
  )
  const rows = await sql(
    "SELECT id FROM agentonic.agent_submissions WHERE configuration_release_id=$1",
    [second.id]
  )
  expect(rows.rows).toHaveLength(0)
  const retained = await sql(
    "SELECT id FROM agentonic.evaluation_preparations WHERE submission_id=$1",
    [first.id]
  )
  expect(retained.rows).toHaveLength(1)
})

it("rolls back a stale revision and rejects missing budget or consent before mutation", async () => {
  const input = await combinedSubmissionFixture()
  for (const changed of [
    { revision: 2 },
    { budgetUsd: undefined },
    { budgetUsd: 2 },
    { consent: false },
  ]) {
    expect(
      (await submitAgentForReview(w, a, { ...input, ...changed })).ok
    ).toBe(false)
  }
  const rows = await sql(
    "SELECT id FROM agentonic.agent_submissions WHERE agent_id=$1",
    [a]
  )
  expect(rows.rows).toHaveLength(0)
})

async function modelReview() {
  const p = await prepareFlow()
  await db.exec("RESET ROLE")
  for (const migration of [
    "202609190033_preview_models",
    "202609190034_frontier_reservations",
    "202609190035_model_evaluations",
    "202609190036_chat_model_levels",
    "202609190037_model_review_receipt_history",
    "202610050038_side_by_side_runtimes",
    "202610050039_side_by_side_brokers",
    "202610050040_admin_expiry_view",
    "202610050041_resting_agents",
    "202610050042_worker_storage",
    "202610050043_worker_lanes",
    "202610060044_general_conversations",
    "202610060045_general_connections",
    "202610060046_usage_events",
    "202610060047_evaluation_tool_cases",
    "202610070052_registration_validity",
    "202610080060_evaluation_lessons",
    "202610080061_style_guides",
    "202610080062_agent_schedules",
    "202610080063_ongoing_deployments",
    "202610090064_careful_grading",
    "202610090066_single_authorization",
    "202610130069_staging_open_reservations",
    "202610130070_mailbox_batch_turns",
    "202610130071_mailbox_followups",
    // Removes two named test agents; any other database is left as it was.
    "202610130072_remove_test_agents",
    "202610130073_turn_steps",
  ])
    await db.exec(
      readFileSync(
        `packages/database/prisma/migrations/${migration}/migration.sql`,
        "utf8"
      )
        .replace(/^BEGIN;/, "")
        .replace(/COMMIT;\s*$/, "")
    )
  await sql(
    "UPDATE agentonic.evaluation_workers SET revoked_at=clock_timestamp() WHERE database_role='agentonic_eval_azure' AND revoked_at IS NULL"
  )
  await sql(
    "WITH w AS (INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,verified_at,verification) VALUES('agentonic_eval_azure','azure_staging',repeat('d',64),now(),'{\"reviewProtocol\":3,\"isolation\":true,\"recovery\":true,\"artifactIntegrity\":true}') RETURNING id) INSERT INTO agentonic.evaluation_worker_runtimes(worker_id,runtime_sha256) SELECT id,repeat('b',64) FROM w"
  )
  await actor()
  await flow("save", {
    preparationId: p.preparationId,
    revision: 0,
    criteria: p.criteria.map((c) => ({ ...c, reviewDecision: "approved" })),
  })
  expect(
    await flow("confirm", {
      preparationId: p.preparationId,
      revision: 1,
      consent: true,
    })
  ).toMatchObject({ ok: true })
  return p
}
describe("platform tool cases", () => {
  it("adds them, with grader version 4, only while the evaluator can answer tools from fixtures", async () => {
    requested.tools = [
      { capability: "web", operations: ["web.search", "web.read"] },
    ]
    const p = await modelReview()
    const run = async (requestId: string, revision: number) => {
      await actor()
      expect(
        await flow("run", {
          preparationId: p.preparationId,
          revision,
          models: [{ model: "gpt-5.4-mini", reasoning: "medium" }],
          budgetUsd: 3,
          consent: true,
          requestId,
        })
      ).toMatchObject({ ok: true })
      return (
        await sql(
          "SELECT (SELECT jsonb_agg(c->>'key') FROM jsonb_array_elements(dataset_snapshot) c) keys,grader_snapshot->>'version' grader FROM agentonic.evaluation_runs WHERE preparation_id=$1 ORDER BY created_at DESC LIMIT 1",
          [p.preparationId]
        )
      ).rows[0] as { keys: string[]; grader: string }
    }
    // The registered evaluator cannot answer tools from fixtures yet: as before.
    const before = await run(id(994), 1)
    expect(before.grader).toBe("grounded-review-v3")
    expect(before.keys).not.toContain("platform-web-injection")
    // Once it can, a new run also tests the web tool.
    await evalCommand("cancel", {
      evaluationId: (
        (
          await sql(
            "SELECT id FROM agentonic.evaluation_runs WHERE preparation_id=$1",
            [p.preparationId]
          )
        ).rows[0] as { id: string }
      ).id,
    }).catch(() => null)
    // A new evaluator release that answers tools from fixtures replaces the old one.
    await sql(
      "UPDATE agentonic.evaluation_workers SET retired_at=clock_timestamp() WHERE database_role='agentonic_eval_azure' AND retired_at IS NULL"
    )
    await sql(
      "WITH w AS (INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,verified_at,verification) VALUES('agentonic_eval_azure','azure_staging',repeat('d',64),now(),'{\"reviewProtocol\":3,\"toolFixtures\":1,\"isolation\":true,\"recovery\":true,\"artifactIntegrity\":true}') RETURNING id) INSERT INTO agentonic.evaluation_worker_runtimes(worker_id,runtime_sha256) SELECT id,repeat('b',64) FROM w"
    )
    await sql(
      "UPDATE agentonic.evaluation_runs SET status='error',lease_token=NULL,lease_until=NULL WHERE preparation_id=$1 AND status IN ('queued','running')",
      [p.preparationId]
    )
    await sql(
      "UPDATE agentonic.evaluation_preparations SET status='criteria_ready' WHERE id=$1",
      [p.preparationId]
    )
    const after = await run(id(995), 1)
    expect(after.grader).toBe("grounded-review-v4")
    expect(after.keys.slice(-1)).toEqual(["platform-web-injection"])
    // The evaluator reads a case's fixtures under its lease: none for a business case.
    const job = (await evalClaim())!
    expect(await execute(job, "fixtures")).toEqual({ fixtures: null })
    await expect(
      execute({ ...job, token: id(996) }, "fixtures")
    ).rejects.toThrow()
  })
})

describe("evaluation lessons (§56)", () => {
  const rubric5 =
    '{"reviewProtocol":3,"toolFixtures":1,"reviewRubric":5,"isolation":true,"recovery":true,"artifactIntegrity":true}'
  async function rubric5Evaluator() {
    await sql(
      "UPDATE agentonic.evaluation_workers SET retired_at=clock_timestamp() WHERE database_role='agentonic_eval_azure' AND retired_at IS NULL"
    )
    await sql(
      `WITH w AS (INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,verified_at,verification) VALUES('agentonic_eval_azure','azure_staging',repeat('d',64),now(),'${rubric5}') RETURNING id) INSERT INTO agentonic.evaluation_worker_runtimes(worker_id,runtime_sha256) SELECT id,repeat('b',64) FROM w`
    )
  }
  it("grades new runs with rubric 5 on GPT-5.4 mini once the evaluator advertises it", async () => {
    const p = await modelReview()
    await rubric5Evaluator()
    await actor()
    expect(
      await flow("run", {
        preparationId: p.preparationId,
        revision: 1,
        models: [{ model: "gpt-5.4", reasoning: "low" }],
        budgetUsd: 3,
        consent: true,
        requestId: id(1001),
      })
    ).toMatchObject({ ok: true })
    // A version without tools also gets rubric 5, without tool cases.
    expect(
      (
        await sql(
          "SELECT grader_snapshot grader,(SELECT jsonb_agg(c->>'key') FROM jsonb_array_elements(dataset_snapshot) c) keys FROM agentonic.evaluation_runs WHERE preparation_id=$1",
          [p.preparationId]
        )
      ).rows[0]
    ).toEqual({
      grader: {
        version: "grounded-review-v5",
        model: "gpt-5.4-mini",
        reasoning: "low",
        policy: "readonly-review-v1",
      },
      keys: ["duration", "platform-unknown", "platform-injection"],
    })
    const job = (await evalClaim())!
    await execute(job, "search", { embedding })
    expect(await execute(job, "grade-context")).toMatchObject({
      rubricVersion: "grounded-review-v5",
    })
    // The grader's model is metered; a model the run does not use is refused.
    expect(
      await execute(job, "reserve", {
        id: id(1002),
        provider: "openai",
        model: "gpt-5.4-mini",
        microusd: 1000,
      })
    ).toMatchObject({ ok: true })
    await expect(
      execute(job, "reserve", {
        id: id(1003),
        provider: "openai",
        model: "gpt-4.1-mini-2025-04-14",
        microusd: 1000,
      })
    ).rejects.toMatchObject({ code: "42501" })
  })
  it("decides a batch per model: failing models are left out of the approval and of Chats", async () => {
    const p = await modelReview()
    const passing = { model: "gpt-5.4-mini", reasoning: "medium" }
    const models = [
      passing,
      { model: "gpt-6-astra", reasoning: "low" },
      { model: "gpt-6-astra", reasoning: "high" },
    ]
    await actor()
    await flow("run", {
      preparationId: p.preparationId,
      revision: 1,
      models,
      budgetUsd: 3,
      consent: true,
      requestId: id(1010),
    })
    // GPT-6 Astra passes at one level and fails at another, so the model fails.
    const verdicts = ["passed", "passed", "needs_changes"]
    for (const [n, configuration] of models.entries())
      await finishFlow(
        (await evalClaim())!,
        verdicts[n],
        true,
        configuration.model
      )
    const first = (
      await sql(
        "SELECT id FROM agentonic.evaluation_runs WHERE preparation_id=$1 ORDER BY created_at LIMIT 1",
        [p.preparationId]
      )
    ).rows[0] as { id: string }
    expect(
      (
        await sql(
          "SELECT p.status,p.evaluation_id,s.status submission FROM agentonic.evaluation_preparations p JOIN agentonic.agent_submissions s ON s.id=p.submission_id WHERE p.id=$1",
          [p.preparationId]
        )
      ).rows[0]
    ).toEqual({
      status: "approved",
      evaluation_id: first.id,
      submission: "approved",
    })
    await actor()
    const state = await db.query<{
      result: { preparations: { summary: string }[] }
    }>("SELECT agentonic.review_flow_state($1) result", [a])
    expect(state.rows[0]!.result.preparations[0]!.summary).toContain(
      "solo los modelos que superaron todas las situaciones"
    )
    await sql(
      "WITH h AS (INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,verified_at,heartbeat_at) VALUES('local','agentonic_deployer_local',repeat('f',64),clock_timestamp(),clock_timestamp()) RETURNING id), b AS (INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256) SELECT id,repeat('f',64) FROM h) INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) SELECT id,repeat('b',64) FROM h"
    )
    await actor()
    const d = await lifecycleCall("deployment_command", "authorize", {
      submissionId: p.submissionId,
      environment: "local",
      budgetUsd: 0.25,
      consent: true,
      requestId: id(1011),
    })
    expect(d.ok).toBe(true)
    await readyStaging({ ...p, deploymentId: String(d.id) })
    await actor()
    const conversation = await chat("start", {
      deploymentId: String(d.id),
      title: "Synthetic per-model chat",
    })
    expect(
      await chat("state", { conversationId: conversation.id })
    ).toMatchObject({ models: [passing] })
    await expect(
      chat("turn", {
        conversationId: conversation.id,
        query: "Synthetic question",
        requestId: id(1012),
        ...models[1],
      })
    ).rejects.toMatchObject({ code: "42501" })
  })
  it("keeps a version unapproved when no model passes every level", async () => {
    const p = await modelReview()
    const models = [
      { model: "gpt-5.4-mini", reasoning: "medium" },
      { model: "gpt-5.4", reasoning: "low" },
    ]
    await actor()
    await flow("run", {
      preparationId: p.preparationId,
      revision: 1,
      models,
      budgetUsd: 3,
      consent: true,
      requestId: id(1020),
    })
    await finishFlow((await evalClaim())!, "uncertain", true, models[0]!.model)
    await finishFlow(
      (await evalClaim())!,
      "needs_changes",
      true,
      models[1]!.model
    )
    expect(
      (
        await sql(
          "SELECT p.status,s.status submission FROM agentonic.evaluation_preparations p JOIN agentonic.agent_submissions s ON s.id=p.submission_id WHERE p.id=$1",
          [p.preparationId]
        )
      ).rows[0]
    ).toEqual({ status: "needs_changes", submission: "submitted" })
  })
  it("no longer starts evaluations with GPT-4.1 mini", async () => {
    const p = await modelReview()
    await actor()
    await expect(
      flow("run", {
        preparationId: p.preparationId,
        revision: 1,
        models: [{ model: "gpt-4.1-mini-2025-04-14", reasoning: null }],
        budgetUsd: 3,
        consent: true,
        requestId: id(1030),
      })
    ).rejects.toMatchObject({ code: "42501" })
  })
  it("lets GPT-5.4 mini write criteria and shows the writer the requested access", async () => {
    const p = await modelReview()
    await actor()
    await flow("cancel", { preparationId: p.preparationId })
    await flow("prepare", {
      submissionId: p.submissionId,
      budgetUsd: 0.25,
      consent: true,
      requestId: id(1040),
    })
    await db.exec("RESET ROLE;SET LOCAL ROLE agentonic_eval_azure")
    const job = (
      await db.query<{ result: Job }>(
        "SELECT agentonic.review_preparation_claim(repeat('d',64)) result"
      )
    ).rows[0]!.result
    expect(job).not.toBeNull()
    expect(await prepWorker(job, "read")).toMatchObject({
      requestedAccess: { collectionIds: [collection], tools: [] },
    })
    expect(
      await prepWorker(job, "reserve", {
        id: id(1041),
        provider: "openai",
        model: "gpt-5.4-mini",
        microusd: 50000,
      })
    ).toMatchObject({ ok: true })
    expect(
      (
        await sql(
          "SELECT model FROM agentonic.retrieval_provider_operations WHERE id=$1",
          [id(1041)]
        )
      ).rows
    ).toEqual([{ model: "gpt-5.4-mini" }])
    await expect(
      prepWorker(job, "reserve", {
        id: id(1042),
        provider: "openai",
        model: "gpt-5.4",
        microusd: 50000,
      })
    ).rejects.toMatchObject({ code: "42501" })
  })
})

describe("careful grading (§61)", () => {
  const verification = (rubric: number) =>
    `{"reviewProtocol":3,"toolFixtures":1,"reviewRubric":${rubric},"isolation":true,"recovery":true,"artifactIntegrity":true}`
  async function evaluator(rubric: number) {
    await sql(
      "UPDATE agentonic.evaluation_workers SET retired_at=clock_timestamp() WHERE database_role='agentonic_eval_azure' AND retired_at IS NULL"
    )
    await sql(
      `WITH w AS (INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,verified_at,verification) VALUES('agentonic_eval_azure','azure_staging',repeat('d',64),now(),'${verification(rubric)}') RETURNING id) INSERT INTO agentonic.evaluation_worker_runtimes(worker_id,runtime_sha256) SELECT id,repeat('b',64) FROM w`
    )
  }
  const graders = (preparationId: string) =>
    sql(
      "SELECT grader_snapshot->>'version' version,grader_snapshot->>'reasoning' reasoning FROM agentonic.evaluation_runs WHERE preparation_id=$1 ORDER BY created_at",
      [preparationId]
    ).then((r) => r.rows)
  it("grades new runs with rubric 6 at medium reasoning once the evaluator advertises it", async () => {
    const p = await modelReview()
    await evaluator(6)
    await actor()
    expect(
      await flow("run", {
        preparationId: p.preparationId,
        revision: 1,
        models: [{ model: "gpt-5.4", reasoning: "low" }],
        budgetUsd: 3,
        consent: true,
        requestId: id(1101),
      })
    ).toMatchObject({ ok: true })
    // A version without tools also gets rubric 6, without tool cases.
    expect(
      (
        await sql(
          "SELECT grader_snapshot grader,(SELECT jsonb_agg(c->>'key') FROM jsonb_array_elements(dataset_snapshot) c) keys FROM agentonic.evaluation_runs WHERE preparation_id=$1",
          [p.preparationId]
        )
      ).rows[0]
    ).toEqual({
      grader: {
        version: "grounded-review-v6",
        model: "gpt-5.4-mini",
        reasoning: "medium",
        policy: "readonly-review-v1",
      },
      keys: ["duration", "platform-unknown", "platform-injection"],
    })
    const job = (await evalClaim())!
    await execute(job, "search", { embedding })
    expect(await execute(job, "grade-context")).toMatchObject({
      rubricVersion: "grounded-review-v6",
    })
    // The grader's model is metered; a model the run does not use is refused.
    expect(
      await execute(job, "reserve", {
        id: id(1102),
        provider: "openai",
        model: "gpt-5.4-mini",
        microusd: 1000,
      })
    ).toMatchObject({ ok: true })
    await expect(
      execute(job, "reserve", {
        id: id(1103),
        provider: "openai",
        model: "gpt-4.1-mini-2025-04-14",
        microusd: 1000,
      })
    ).rejects.toMatchObject({ code: "42501" })
  })
  it("keeps rubric 5 for an evaluator that advertises 5 and for runs created under it", async () => {
    const p = await modelReview()
    await evaluator(5)
    await actor()
    await flow("run", {
      preparationId: p.preparationId,
      revision: 1,
      models: [{ model: "gpt-5.4-mini", reasoning: "medium" }],
      budgetUsd: 3,
      consent: true,
      requestId: id(1110),
    })
    expect(await graders(p.preparationId)).toEqual([
      { version: "grounded-review-v5", reasoning: "low" },
    ])
    // A rubric 6 evaluator replaces it and finishes the queued rubric 5 run as it was.
    await evaluator(6)
    await finishFlow((await evalClaim())!, "passed", true, "gpt-5.4-mini")
    expect(await graders(p.preparationId)).toEqual([
      { version: "grounded-review-v5", reasoning: "low" },
    ])
    expect(
      (
        await sql(
          "SELECT status FROM agentonic.evaluation_runs WHERE preparation_id=$1",
          [p.preparationId]
        )
      ).rows
    ).toEqual([{ status: "passed" }])
  })
})

describe("scheduled jobs (§58)", () => {
  const trace = id(1100)
  async function schedule(operation: string, payload: Record<string, unknown>) {
    await db.exec("SAVEPOINT schedule")
    try {
      const r = await db.query<{ r: Record<string, unknown> }>(
        "SELECT agentonic.schedule_command($1,$2::jsonb,$3::uuid) r",
        [operation, JSON.stringify(payload), trace]
      )
      await db.exec("RELEASE SAVEPOINT schedule")
      return r.rows[0]!.r
    } catch (e) {
      await db.exec(
        "ROLLBACK TO SAVEPOINT schedule; RELEASE SAVEPOINT schedule"
      )
      throw e
    }
  }
  const state = async () =>
    (
      await db.query<{
        r: {
          deployment: { models: unknown[]; writes: string[] } | null
          schedules: (Record<string, unknown> & {
            runs: (Record<string, unknown> & {
              actions: Record<string, unknown>[]
            })[]
          })[]
        }
      }>("SELECT agentonic.schedule_state($1) r", [a])
    ).rows[0]!.r
  async function asWorker<T>(query: string, params: unknown[] = []) {
    await db.exec(
      "RESET ROLE; SET LOCAL ROLE agentonic_worker; SAVEPOINT schedule_worker"
    )
    try {
      const r = await db.query<{ r: T }>(query, params)
      await db.exec("RELEASE SAVEPOINT schedule_worker")
      return r.rows[0]!.r
    } catch (e) {
      await db.exec(
        "ROLLBACK TO SAVEPOINT schedule_worker; RELEASE SAVEPOINT schedule_worker"
      )
      throw e
    }
  }
  const tick = () =>
    asWorker<{ queued: number; skipped: number }>(
      "SELECT agentonic.schedule_tick() r"
    )
  const base = {
    name: "Resumen diario",
    instruction: "Resume los correos importantes de ayer.",
    cadence: "daily",
    timeOfDay: "08:00",
    weekday: null,
    everyHours: null,
    timezone: "America/Caracas",
    model: "gpt-5.4-mini",
    reasoning: "medium",
    autonomy: [],
    consent: false,
  }
  /** A version approved with GPT-5.4 mini and running, with Gmail tools when asked. */
  async function running(gmail = false) {
    if (gmail) {
      await sql(
        "INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext,operations) VALUES($1,$2,$3,$4,'synthetic@example.invalid','opaque','[\"gmail.read\",\"gmail.send\"]')",
        [id(770), w, a, member]
      )
      requested.tools = [
        { connectionId: id(770), operations: ["gmail.read", "gmail.send"] },
      ]
    }
    const p = await modelReview()
    await actor()
    await flow("run", {
      preparationId: p.preparationId,
      revision: 1,
      models: [{ model: "gpt-5.4-mini", reasoning: "medium" }],
      budgetUsd: 3,
      consent: true,
      requestId: id(1101),
    })
    const job = (await evalClaim())!
    await finishFlow(job, "passed", true, "gpt-5.4-mini")
    // Versions with tools need staff approval.
    if (gmail)
      expect(await approve({ ...p, evaluationId: job.id })).toMatchObject({
        ok: true,
      })
    await sql(
      "WITH h AS (INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,verified_at,heartbeat_at) VALUES('local','agentonic_deployer_local',repeat('f',64),clock_timestamp(),clock_timestamp()) RETURNING id), b AS (INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256) SELECT id,repeat('f',64) FROM h) INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) SELECT id,repeat('b',64) FROM h"
    )
    await actor()
    const d = await lifecycleCall("deployment_command", "authorize", {
      submissionId: p.submissionId,
      environment: "local",
      budgetUsd: 0.25,
      consent: true,
      requestId: id(1102),
    })
    expect(d.ok).toBe(true)
    await readyStaging({ ...p, deploymentId: String(d.id) })
    await actor()
    return { ...p, deploymentId: String(d.id) }
  }

  it("computes due times in the schedule's own timezone", async () => {
    await modelReview()
    const next = async (
      cadence: string,
      at: string,
      weekday: number | null,
      hours: number | null,
      tz: string,
      after: string
    ) =>
      (
        (
          await sql(
            "SELECT agentonic.schedule_next($1,$2::time,$3::smallint,$4::smallint,$5,$6::timestamptz) t",
            [cadence, at, weekday, hours, tz, after]
          )
        ).rows[0] as { t: Date }
      ).t.toISOString()
    // Caracas is UTC-4. 09:00 there has passed 08:00, so tomorrow.
    expect(
      await next(
        "daily",
        "08:00",
        null,
        null,
        "America/Caracas",
        "2026-10-08T13:00:00Z"
      )
    ).toBe("2026-10-09T12:00:00.000Z")
    // From a Friday afternoon, weekdays resume on Monday.
    expect(
      await next(
        "weekdays",
        "08:00",
        null,
        null,
        "America/Caracas",
        "2026-10-09T13:00:00Z"
      )
    ).toBe("2026-10-12T12:00:00.000Z")
    // Wednesdays at 18:30 in Madrid (UTC+2 in October), from a Thursday.
    expect(
      await next(
        "weekly",
        "18:30",
        3,
        null,
        "Europe/Madrid",
        "2026-10-08T10:00:00Z"
      )
    ).toBe("2026-10-14T16:30:00.000Z")
    // Every 6 hours from 08:00: 08, 14, 20, then 08 the next day.
    expect(
      await next(
        "hours",
        "08:00",
        null,
        6,
        "America/Caracas",
        "2026-10-08T15:00:00Z"
      )
    ).toBe("2026-10-08T18:00:00.000Z")
    expect(
      await next(
        "hours",
        "08:00",
        null,
        6,
        "America/Caracas",
        "2026-10-09T00:30:00Z"
      )
    ).toBe("2026-10-09T12:00:00.000Z")
  })

  it("keeps a member's schedules to themselves, validated, and pausable", async () => {
    await modelReview()
    await actor()
    const create = (overrides: Record<string, unknown>, n: number) =>
      schedule("create", {
        ...base,
        agentId: a,
        requestId: id(n),
        ...overrides,
      })
    await expect(create({ timezone: "Mars/Olympus" }, 1110)).rejects.toThrow()
    await expect(
      create({ model: "gpt-4.1-mini-2025-04-14", reasoning: null }, 1111)
    ).rejects.toThrow()
    // Pre-authorizing a write needs consent, and only writes can be pre-authorized.
    await expect(create({ autonomy: ["gmail.send"] }, 1112)).rejects.toThrow()
    await expect(
      create({ autonomy: ["gmail.read"], consent: true }, 1113)
    ).rejects.toThrow()
    const made = await create({ autonomy: ["gmail.send"], consent: true }, 1114)
    expect(made).toMatchObject({ ok: true })
    expect(await create({}, 1114)).toEqual(made)
    const listed = (await state()).schedules
    expect(listed).toMatchObject([
      {
        name: "Resumen diario",
        cadence: "daily",
        timeOfDay: "08:00",
        autonomy: ["gmail.send"],
        status: "active",
      },
    ])
    expect(listed[0]!.nextRunAt).toBeTruthy()
    await schedule("pause", { id: made.id })
    expect((await state()).schedules[0]).toMatchObject({
      status: "paused",
      nextRunAt: null,
    })
    await schedule("resume", { id: made.id })
    expect((await state()).schedules[0]!.nextRunAt).toBeTruthy()
    await actor(other, otherW)
    await expect(schedule("pause", { id: made.id })).rejects.toThrow()
    await actor()
    await schedule("delete", { id: made.id })
    expect((await state()).schedules).toEqual([])
  })

  it("queues one turn in its own conversation when due, collapsing missed times, and skips when it cannot run", async () => {
    // Without a running deployment a run is skipped, not queued.
    await modelReview()
    await actor()
    const lonely = await schedule("create", {
      ...base,
      agentId: a,
      requestId: id(1120),
    })
    expect(await schedule("run", { id: lonely.id })).toMatchObject({
      status: "skipped",
      reason: "no_deployment",
    })
  })

  it("runs a due schedule on the member's running deployment, once for missed times", async () => {
    const p = await running()
    const made = await schedule("create", {
      ...base,
      agentId: a,
      requestId: id(1121),
    })
    await sql(
      "UPDATE agentonic.agent_schedules SET next_run_at=clock_timestamp()-interval '3 hours' WHERE id=$1",
      [made.id]
    )
    expect(await tick()).toEqual({ queued: 1, skipped: 0 })
    expect(await tick()).toEqual({ queued: 0, skipped: 0 })
    await actor()
    const run = (await state()).schedules[0]!.runs[0]!
    expect(run).toMatchObject({ status: "queued", manual: false })
    const turn = (
      await sql(
        "SELECT t.query,t.response_model,c.title,c.schedule_id FROM agentonic.staging_turns t JOIN agentonic.staging_conversations c ON c.id=t.conversation_id WHERE c.id=$1",
        [run.conversationId]
      )
    ).rows[0] as Record<string, string>
    expect(turn).toMatchObject({
      title: "Programación: Resumen diario",
      schedule_id: made.id,
      response_model: "gpt-5.4-mini",
    })
    expect(turn.query).toContain("Resume los correos importantes de ayer.")
    expect(turn.query).toContain("Se ejecuta sin una persona presente")
    expect(
      (
        (
          await sql(
            "SELECT next_run_at>clock_timestamp() later FROM agentonic.agent_schedules WHERE id=$1",
            [made.id]
          )
        ).rows[0] as { later: boolean }
      ).later
    ).toBe(true)
    // A run waiting in the conversation makes the next one skip.
    await actor()
    expect(await schedule("run", { id: made.id })).toMatchObject({
      status: "skipped",
      reason: "busy",
    })
    // The run follows its turn.
    await stagingWork(p.deploymentId, "claim")
    await actor()
    expect((await state()).schedules[0]!.runs.at(-1)).toMatchObject({
      status: "running",
    })
  })

  it("executes the one write a run proposes when its schedule pre-authorized it, and nothing else", async () => {
    const p = await running(true)
    expect((await state()).deployment?.writes).toEqual(["gmail.send"])
    const made = await schedule("create", {
      ...base,
      agentId: a,
      requestId: id(1130),
      autonomy: ["gmail.send"],
      consent: true,
    })
    expect(await schedule("run", { id: made.id })).toMatchObject({
      status: "queued",
    })
    const job = (await stagingWork(p.deploymentId, "claim")) as unknown as Job
    const tool = async (payload: Record<string, unknown>) => {
      await db.exec(
        "RESET ROLE; SET LOCAL ROLE agentonic_runtime_local; SAVEPOINT tool"
      )
      const r = await db.query<{ r: Record<string, unknown> }>(
        "SELECT agentonic.gmail_staging('gmail-propose',$1,$2,$3,$4,$5) r",
        [
          p.deploymentId,
          serviceSecret,
          job.id,
          job.token,
          JSON.stringify(payload),
        ]
      )
      await db.exec("RELEASE SAVEPOINT tool")
      return r.rows[0]!.r
    }
    const send = (n: number) => ({
      connectionId: id(770),
      operation: "gmail.send",
      id: id(n),
      argumentsCiphertext: "opaque-message",
      hash: "a".repeat(64),
    })
    expect(await tool(send(1131))).toMatchObject({
      pendingApproval: true,
      automatic: true,
    })
    // One write per run: a second proposal waits for the person.
    expect(await tool(send(1132))).toMatchObject({ automatic: false })
    // The person cannot confirm the pre-authorized write, only cancel it.
    await actor()
    await expect(
      gmailCommand("confirm", { id: id(1131), hash: "a".repeat(64) })
    ).rejects.toThrow()
    expect(
      (
        (
          await gmailCommand("invocations", {
            conversationId: (await state()).schedules[0]!.runs[0]!
              .conversationId,
          })
        ).items as Record<string, unknown>[]
      ).map((i) => i.automatic)
    ).toEqual([true, false])
    // The worker runs it once, with the credential, and records the outcome.
    const claimed = await asWorker<Record<string, unknown>>(
      "SELECT agentonic.schedule_action_claim() r"
    )
    expect(claimed).toMatchObject({
      id: id(1131),
      lane: "action",
      operation: "gmail.send",
      credential: "opaque",
      argumentsCiphertext: "opaque-message",
    })
    expect(
      await asWorker("SELECT agentonic.schedule_action_claim() r")
    ).toBeNull()
    await asWorker(
      "SELECT agentonic.schedule_action_complete($1,'succeeded',$2::jsonb) r",
      [id(1131), JSON.stringify({ id: "sent-1" })]
    )
    await expect(
      asWorker(
        "SELECT agentonic.schedule_action_complete($1,'succeeded','{}'::jsonb) r",
        [id(1131)]
      )
    ).rejects.toThrow()
    expect(
      (
        await sql(
          "SELECT id,status,arguments_ciphertext IS NULL erased FROM agentonic.gmail_invocations ORDER BY id",
          []
        )
      ).rows
    ).toEqual([
      { id: id(1131), status: "succeeded", erased: true },
      { id: id(1132), status: "pending", erased: false },
    ])
    await actor()
    expect((await state()).schedules[0]!.runs[0]!.actions).toEqual([
      { operation: "gmail.send", status: "succeeded", automatic: true },
      { operation: "gmail.send", status: "pending", automatic: false },
    ])
  })

  it("lets one chat turn leave up to 10 Gmail proposals (§67)", async () => {
    const p = await running(true)
    const c = await chat("start", {
      deploymentId: p.deploymentId,
      title: "Synthetic batch",
    })
    await chat("turn", {
      conversationId: c.id,
      requestId: id(1140),
      query: "Prepara las respuestas",
    })
    const job = (await stagingWork(p.deploymentId, "claim")) as unknown as Job
    const propose = async (n: number) => {
      await db.exec(
        "RESET ROLE; SET LOCAL ROLE agentonic_runtime_local; SAVEPOINT batch_tool"
      )
      try {
        const r = await db.query<{ r: Record<string, unknown> }>(
          "SELECT agentonic.gmail_staging('gmail-propose',$1,$2,$3,$4,$5) r",
          [
            p.deploymentId,
            serviceSecret,
            job.id,
            job.token,
            JSON.stringify({
              connectionId: id(770),
              operation: "gmail.send",
              id: id(n),
              argumentsCiphertext: "opaque-message",
              hash: "a".repeat(64),
            }),
          ]
        )
        await db.exec("RELEASE SAVEPOINT batch_tool")
        return r.rows[0]!.r
      } catch (e) {
        await db.exec(
          "ROLLBACK TO SAVEPOINT batch_tool; RELEASE SAVEPOINT batch_tool"
        )
        throw e
      }
    }
    for (let n = 0; n < 10; n++)
      expect(await propose(1141 + n)).toMatchObject({ pendingApproval: true })
    await expect(propose(1151)).rejects.toMatchObject({ code: "42501" })
  })

  it("stops pre-authorized writes when the schedule loses that authority", async () => {
    const p = await running(true)
    const made = await schedule("create", {
      ...base,
      agentId: a,
      requestId: id(1140),
      autonomy: ["gmail.send"],
      consent: true,
    })
    await schedule("run", { id: made.id })
    const job = (await stagingWork(p.deploymentId, "claim")) as unknown as Job
    await db.exec("RESET ROLE; SET LOCAL ROLE agentonic_runtime_local")
    await db.query(
      "SELECT agentonic.gmail_staging('gmail-propose',$1,$2,$3,$4,$5)",
      [
        p.deploymentId,
        serviceSecret,
        job.id,
        job.token,
        JSON.stringify({
          connectionId: id(770),
          operation: "gmail.send",
          id: id(1141),
          argumentsCiphertext: "opaque-message",
          hash: "a".repeat(64),
        }),
      ]
    )
    // Deleting the schedule cancels what it pre-authorized and has not started.
    await actor()
    await schedule("delete", { id: made.id })
    expect(
      await asWorker("SELECT agentonic.schedule_action_claim() r")
    ).toBeNull()
    expect(
      (
        await sql(
          "SELECT status,arguments_ciphertext FROM agentonic.gmail_invocations WHERE id=$1",
          [id(1141)]
        )
      ).rows
    ).toEqual([{ status: "cancelled", arguments_ciphertext: null }])
  })
})

describe("ongoing deployments (§59)", () => {
  /** A routine version approved with GPT-5.4 mini and running with a US$5 period. */
  async function running() {
    const p = await modelReview()
    await actor()
    await flow("run", {
      preparationId: p.preparationId,
      revision: 1,
      models: [{ model: "gpt-5.4-mini", reasoning: "medium" }],
      budgetUsd: 3,
      consent: true,
      requestId: id(1201),
    })
    await finishFlow((await evalClaim())!, "passed", true, "gpt-5.4-mini")
    await sql(
      "WITH h AS (INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,verified_at,heartbeat_at) VALUES('local','agentonic_deployer_local',repeat('f',64),clock_timestamp(),clock_timestamp()) RETURNING id), b AS (INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256) SELECT id,repeat('f',64) FROM h) INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) SELECT id,repeat('b',64) FROM h"
    )
    await actor()
    const d = await lifecycleCall("deployment_command", "authorize", {
      submissionId: p.submissionId,
      environment: "local",
      budgetUsd: 5,
      consent: true,
      requestId: id(1202),
    })
    expect(d.ok).toBe(true)
    await readyStaging({ ...p, deploymentId: String(d.id) })
    await actor()
    return { ...p, deploymentId: String(d.id) }
  }
  /** Moves a deployment's end, which renewal itself may only extend. */
  async function endsIn(deploymentId: string, interval: string) {
    await sql(
      "ALTER TABLE agentonic.deployments DISABLE TRIGGER deployment_immutable"
    )
    await sql(
      `UPDATE agentonic.deployments SET authorized_until=clock_timestamp()+interval '${interval}' WHERE id=$1`,
      [deploymentId]
    )
    await sql(
      "ALTER TABLE agentonic.deployments ENABLE TRIGGER deployment_immutable"
    )
  }
  const deployment = async (deploymentId: string) =>
    (
      await sql(
        "SELECT round(extract(epoch FROM authorized_until-created_at)/86400)::int days,auto_renew,period_budget_usd::float budget,budget_usd::float ceiling,renewal_blocked FROM agentonic.deployments WHERE id=$1",
        [deploymentId]
      )
    ).rows[0] as Record<string, unknown>
  async function renewalTick() {
    await db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
    return (
      await db.query<{ r: Record<string, number> }>(
        "SELECT agentonic.deployment_renewal_tick() r"
      )
    ).rows[0]!.r
  }
  const customerDeployment = async (deploymentId: string) => {
    await actor()
    const state = (
      await db.query<{ r: { deployments: Record<string, unknown>[] } }>(
        "SELECT agentonic.lifecycle_state($1) r",
        [a]
      )
    ).rows[0]!.r
    return state.deployments.find((d) => d.id === deploymentId)!
  }

  it("authorizes a version once per host until that authorization ends", async () => {
    const p = await running()
    const canAuthorize = async () => {
      await actor()
      return (
        await db.query<{
          r: { submissions: { id: string; canAuthorize: boolean }[] }
        }>("SELECT agentonic.lifecycle_state($1) r", [a])
      ).rows[0]!.r.submissions.find((s) => s.id === p.submissionId)!
        .canAuthorize
    }
    const authorize = async (request: number, budgetUsd: number) => {
      await actor()
      return lifecycleCall("deployment_command", "authorize", {
        submissionId: p.submissionId,
        environment: "local",
        budgetUsd,
        consent: true,
        requestId: id(request),
      })
    }
    const count = async () =>
      (
        await sql(
          "SELECT count(*)::int n FROM agentonic.deployments WHERE submission_id=$1",
          [p.submissionId]
        )
      ).rows[0]
    // Running: no second authorization, even with another budget; retrying
    // the original request still answers with the same deployment.
    expect(await canAuthorize()).toBe(false)
    expect(await authorize(1210, 20)).toEqual({
      ok: false,
      code: "already_authorized",
    })
    expect(await authorize(1202, 5)).toEqual({ ok: true, id: p.deploymentId })
    expect(await count()).toEqual({ n: 1 })
    // Stopped: the version can be authorized again, once.
    await actor()
    expect(
      (
        await lifecycleCall("deployment_command", "stop", {
          deploymentId: p.deploymentId,
        })
      ).ok
    ).toBe(true)
    expect(await canAuthorize()).toBe(true)
    expect((await authorize(1211, 5)).ok).toBe(true)
    // Pending activation counts as well.
    expect(await canAuthorize()).toBe(false)
    expect(await authorize(1212, 20)).toEqual({
      ok: false,
      code: "already_authorized",
    })
    expect(await count()).toEqual({ n: 2 })
  })

  it("authorizes 30 days with a period budget and renews automatically while nothing changed", async () => {
    const p = await running()
    expect(await deployment(p.deploymentId)).toMatchObject({
      days: 30,
      auto_renew: true,
      budget: 5,
    })
    expect(await renewalTick()).toEqual({ renewed: 0, blocked: 0 })
    await endsIn(p.deploymentId, "2 days")
    expect(await renewalTick()).toEqual({ renewed: 1, blocked: 0 })
    const renewed = (
      await sql(
        "SELECT kind,renewed_by_member_id,round(extract(epoch FROM authorized_until-previous_until)/86400)::int days,period_budget_usd::float budget FROM agentonic.deployment_renewals WHERE deployment_id=$1",
        [p.deploymentId]
      )
    ).rows
    expect(renewed).toEqual([
      {
        kind: "automatic",
        renewed_by_member_id: null,
        days: 30,
        budget: 5,
      },
    ])
    expect(await customerDeployment(p.deploymentId)).toMatchObject({
      autoRenew: true,
      renewals: 1,
      renewalBlocked: null,
      periodCommittedMicrousd: 0,
    })
    expect(await renewalTick()).toEqual({ renewed: 0, blocked: 0 })
  })

  it("does not renew a deployment whose sources changed, and says why", async () => {
    const p = await running()
    await endsIn(p.deploymentId, "2 days")
    await sql(
      "UPDATE agentonic.document_chunks SET content_sha256=repeat('9',64) WHERE id IN (SELECT (hit->>'id')::uuid FROM agentonic.deployments d CROSS JOIN LATERAL jsonb_array_elements(d.evidence_sources) hit WHERE d.id=$1)",
      [p.deploymentId]
    )
    expect(await renewalTick()).toEqual({ renewed: 0, blocked: 1 })
    expect(await deployment(p.deploymentId)).toMatchObject({
      renewal_blocked: "sources",
    })
    expect(await customerDeployment(p.deploymentId)).toMatchObject({
      renewalBlocked: "sources",
      canRenewNow: false,
    })
  })

  it("lets the customer turn renewal off, change the period budget and renew by hand near the end", async () => {
    const p = await running()
    await actor()
    expect(
      await lifecycleCall("deployment_command", "renewal", {
        deploymentId: p.deploymentId,
        autoRenew: false,
        budgetUsd: 8,
      })
    ).toMatchObject({ ok: true })
    expect(await deployment(p.deploymentId)).toMatchObject({
      auto_renew: false,
      budget: 8,
    })
    await endsIn(p.deploymentId, "2 days")
    expect(await renewalTick()).toEqual({ renewed: 0, blocked: 0 })
    await endsIn(p.deploymentId, "20 days")
    await actor()
    expect(
      await lifecycleCall("deployment_command", "extend", {
        deploymentId: p.deploymentId,
      })
    ).toEqual({ ok: false, code: "too_early" })
    await endsIn(p.deploymentId, "5 days")
    await actor()
    expect(
      await lifecycleCall("deployment_command", "extend", {
        deploymentId: p.deploymentId,
      })
    ).toMatchObject({ ok: true })
    expect(
      (
        await sql(
          "SELECT kind,renewed_by_member_id FROM agentonic.deployment_renewals WHERE deployment_id=$1",
          [p.deploymentId]
        )
      ).rows
    ).toEqual([{ kind: "manual", renewed_by_member_id: member }])
    // Only the customer who authorized it controls its renewal.
    await actor(other, otherW)
    await expect(
      lifecycleCall("deployment_command", "renewal", {
        deploymentId: p.deploymentId,
        autoRenew: true,
        budgetUsd: 5,
      })
    ).rejects.toThrow()
  })

  it("keeps conversations across a version change and past the old version's end, until 30 days after the last message", async () => {
    const p = await running()
    const conversation = await chat("start", {
      deploymentId: p.deploymentId,
      title: "Synthetic continuity",
    })
    await chat("turn", {
      conversationId: conversation.id,
      requestId: id(1210),
      query: "Synthetic question",
    })
    const kept = (
      await sql(
        "SELECT expires_at-clock_timestamp()>interval '29 days' long FROM agentonic.staging_conversations WHERE id=$1",
        [conversation.id]
      )
    ).rows[0] as { long: boolean }
    expect(kept.long).toBe(true)
    // A new version the same member authorized takes over.
    const next = id(1211)
    await sql(
      "UPDATE agentonic.deployments SET status='superseded',desired_state='stopped',service_token_sha256=NULL WHERE id=$1",
      [p.deploymentId]
    )
    await sql(
      "INSERT INTO agentonic.deployments(id,workspace_id,agent_id,code_release_id,configuration_release_id,submission_id,approval_id,host_id,environment,authorized_by_member_id,request_id,status,desired_state,budget_usd,authorized_until,evidence_sources,auto_renew,period_budget_usd,activated_at,heartbeat_at,manifest_sha256,broker_sha256) SELECT $2,workspace_id,agent_id,code_release_id,configuration_release_id,submission_id,approval_id,host_id,environment,authorized_by_member_id,$3,'running','running',budget_usd,authorized_until,evidence_sources,true,period_budget_usd,clock_timestamp(),clock_timestamp(),manifest_sha256,broker_sha256 FROM agentonic.deployments WHERE id=$1",
      [p.deploymentId, next, id(1212)]
    )
    await sql(
      "UPDATE agentonic.agent_environments SET current_deployment_id=$1 WHERE agent_id=$2",
      [next, a]
    )
    expect(
      (
        await sql(
          "SELECT c.deployment_id,t.deployment_id answered_by FROM agentonic.staging_conversations c JOIN agentonic.staging_turns t ON t.conversation_id=c.id WHERE c.id=$1",
          [conversation.id]
        )
      ).rows
    ).toEqual([{ deployment_id: next, answered_by: p.deploymentId }])
    await actor()
    expect(
      await chat("state", { conversationId: conversation.id })
    ).toMatchObject({
      ok: true,
      canSend: true,
      turns: [{ query: "Synthetic question", version: 1 }],
    })
    // The version's authorization ends: still readable, no longer sendable,
    // and the host's cleanup keeps the content.
    await sql(
      "ALTER TABLE agentonic.deployments DISABLE TRIGGER deployment_immutable"
    )
    await sql(
      "UPDATE agentonic.deployments SET created_at=clock_timestamp()-interval '31 days',authorized_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [next]
    )
    await sql(
      "ALTER TABLE agentonic.deployments ENABLE TRIGGER deployment_immutable"
    )
    await hostCall("poll")
    await actor()
    expect(
      await chat("state", { conversationId: conversation.id })
    ).toMatchObject({
      ok: true,
      canSend: false,
      turns: [{ query: "Synthetic question" }],
    })
    expect(
      await chat("turn", {
        conversationId: conversation.id,
        requestId: id(1213),
        query: "Another question",
      })
    ).toMatchObject({ ok: false, code: "unavailable" })
    // Revocation still erases at once.
    await sql(
      "ALTER TABLE agentonic.deployments DISABLE TRIGGER deployment_immutable"
    )
    await sql(
      "UPDATE agentonic.deployments SET revoked_at=clock_timestamp() WHERE id=$1",
      [next]
    )
    await sql(
      "ALTER TABLE agentonic.deployments ENABLE TRIGGER deployment_immutable"
    )
    await hostCall("poll")
    expect(
      (
        await sql(
          "SELECT query,scrubbed_at IS NOT NULL scrubbed FROM agentonic.staging_turns WHERE conversation_id=$1",
          [conversation.id]
        )
      ).rows
    ).toEqual([{ query: "", scrubbed: true }])
  })
})

describe("open reservations in activated chats (§66)", () => {
  it("records the answer while a failed web read keeps its reservation; only the budget refuses it", async () => {
    const p = await modelReview()
    await actor()
    await flow("run", {
      preparationId: p.preparationId,
      revision: 1,
      models: [{ model: "gpt-5.4-mini", reasoning: "medium" }],
      budgetUsd: 3,
      consent: true,
      requestId: id(1301),
    })
    await finishFlow((await evalClaim())!, "passed", true, "gpt-5.4-mini")
    await sql(
      "WITH h AS (INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,verified_at,heartbeat_at) VALUES('local','agentonic_deployer_local',repeat('f',64),clock_timestamp(),clock_timestamp()) RETURNING id), b AS (INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256) SELECT id,repeat('f',64) FROM h) INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) SELECT id,repeat('b',64) FROM h"
    )
    await actor()
    const d = await lifecycleCall("deployment_command", "authorize", {
      submissionId: p.submissionId,
      environment: "local",
      budgetUsd: 5,
      consent: true,
      requestId: id(1302),
    })
    const deploymentId = String(d.id)
    await readyStaging({ ...p, deploymentId })
    await actor()
    const conversation = await chat("start", {
      deploymentId,
      title: "Synthetic redirect",
    })
    await chat("turn", {
      conversationId: conversation.id,
      requestId: id(1303),
      query: "Read a page that redirects",
      model: "gpt-5.4-mini",
      reasoning: "medium",
    })
    const job = (await stagingWork(deploymentId, "claim")) as unknown as Job
    // A redirected web read: reserved and charged, never settled or refunded.
    await sql(
      "INSERT INTO agentonic.retrieval_provider_operations(id,job_id,workspace_id,provider,model,reserved_microusd,agent_id,deployment_id,conversation_id) VALUES($1,$2,$3,'browserbase','web.read',4000,$4,$5,$6)",
      [id(1304), job.id, w, a, deploymentId, conversation.id]
    )
    const answer = {
      text: "The page redirected, so its content is unverified.",
      citations: [],
      insufficientEvidence: true,
      model: "gpt-5.4-mini",
    }
    await sql(
      "UPDATE agentonic.deployments SET committed_microusd=budget_usd*1000000+1 WHERE id=$1",
      [deploymentId]
    )
    await expect(
      stagingWork(deploymentId, "answer", job, answer)
    ).rejects.toMatchObject({ code: "42501" })
    await sql(
      "UPDATE agentonic.deployments SET committed_microusd=4000 WHERE id=$1",
      [deploymentId]
    )
    expect(await stagingWork(deploymentId, "answer", job, answer)).toEqual({
      ok: true,
    })
    expect(
      (
        await sql(
          "SELECT status FROM agentonic.retrieval_provider_operations WHERE id=$1",
          [id(1304)]
        )
      ).rows
    ).toEqual([{ status: "reserved" }])
    await actor()
    expect(
      await chat("state", { conversationId: conversation.id })
    ).toMatchObject({
      ok: true,
      turns: [{ answer: answer.text, status: "succeeded" }],
    })
  })
})

describe("mailbox batch turns (§67)", () => {
  /** Flags the fixture's code release as a mailbox-batch runtime (0.7.0). */
  async function batchRuntime() {
    await sql(
      "ALTER TABLE agentonic.code_releases DISABLE TRIGGER authoring_guard"
    )
    await sql(
      `UPDATE agentonic.code_releases SET execution_manifest=execution_manifest||'{"mailboxBatch":"1"}' WHERE id=$1`,
      [code]
    )
    await sql(
      "ALTER TABLE agentonic.code_releases ENABLE TRIGGER authoring_guard"
    )
  }
  async function running() {
    const p = await modelReview()
    await actor()
    await flow("run", {
      preparationId: p.preparationId,
      revision: 1,
      models: [{ model: "gpt-5.4-mini", reasoning: "medium" }],
      budgetUsd: 3,
      consent: true,
      requestId: id(1401),
    })
    await finishFlow((await evalClaim())!, "passed", true, "gpt-5.4-mini")
    await sql(
      "WITH h AS (INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,verified_at,heartbeat_at) VALUES('local','agentonic_deployer_local',repeat('f',64),clock_timestamp(),clock_timestamp()) RETURNING id), b AS (INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256) SELECT id,repeat('f',64) FROM h) INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) SELECT id,repeat('b',64) FROM h"
    )
    await actor()
    const d = await lifecycleCall("deployment_command", "authorize", {
      submissionId: p.submissionId,
      environment: "local",
      budgetUsd: 5,
      consent: true,
      requestId: id(1402),
    })
    const deploymentId = String(d.id)
    await readyStaging({ ...p, deploymentId })
    await actor()
    return deploymentId
  }

  it("gives batch runtimes 5 minutes, long answers and their earlier Gmail actions; earlier runtimes keep 2 minutes", async () => {
    const deploymentId = await running()
    const conversation = await chat("start", {
      deploymentId,
      title: "Synthetic inbox",
    })
    const ask = async (n: number) => {
      await actor()
      await chat("turn", {
        conversationId: conversation.id,
        requestId: id(n),
        query: "Revisa mis correos",
        model: "gpt-5.4-mini",
        reasoning: "medium",
      })
      return (await stagingWork(deploymentId, "claim")) as unknown as Job
    }
    const first = await ask(1403)
    const long = "x".repeat(13000)
    await stagingWork(deploymentId, "answer", first, {
      text: long,
      citations: [],
      insufficientEvidence: true,
      model: "gpt-5.4-mini",
    })
    // The first turn proposed a draft that the owner confirmed.
    await sql(
      "INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext,operations) VALUES($1,$2,$3,$4,'synthetic@example.invalid','opaque','[\"gmail.drafts.create\"]')",
      [id(1404), w, a, member]
    )
    // Recorded as history only: the version's tool registry is not under test.
    await sql("SET LOCAL session_replication_role=replica")
    await sql(
      `INSERT INTO agentonic.gmail_invocations(id,workspace_id,agent_id,connection_id,owner_member_id,turn_id,conversation_id,operation,arguments_sha256,status,result)
       VALUES($1,$2,$3,$4,$5,$6,$7,'gmail.drafts.create',repeat('a',64),'succeeded','{"id":"r-1","message":{"id":"m-1"},"threadId":"t-1"}')`,
      [id(1405), w, a, id(1404), member, first.id, conversation.id]
    )
    await sql("SET LOCAL session_replication_role=origin")
    const second = await ask(1406)
    /** Seconds from the turn's start to the expiry its envelope carries. */
    const window = async () => {
      const context = await stagingWork(deploymentId, "context", second)
      const turn = (
        await sql(
          "SELECT started_at FROM agentonic.staging_turns WHERE id=$1",
          [second.id]
        )
      ).rows[0] as { started_at: Date }
      return Math.round(
        (Date.parse(String(context.expiresAt)) -
          new Date(turn.started_at).getTime()) /
          1000
      )
    }
    // An earlier runtime: 2 minutes, answers within 12,000 characters, no actions.
    const legacy = await stagingWork(deploymentId, "context", second)
    const before = (
      legacy.history as { answer: string; actions?: unknown }[]
    )[0]!
    expect(before.answer).toHaveLength(12000)
    expect(before).not.toHaveProperty("actions")
    expect(await window()).toBe(120)
    await sql(
      "UPDATE agentonic.staging_turns SET started_at=clock_timestamp()-interval '3 minutes' WHERE id=$1",
      [second.id]
    )
    await expect(
      stagingWork(deploymentId, "heartbeat", second)
    ).rejects.toMatchObject({ code: "42501" })
    // The same turn on a batch runtime: 5 minutes, the whole answer, the actions.
    await batchRuntime()
    expect(await stagingWork(deploymentId, "heartbeat", second)).toEqual({
      ok: true,
    })
    const batch = await stagingWork(deploymentId, "context", second)
    expect(batch.history).toEqual([
      {
        query: "Revisa mis correos",
        answer: long,
        actions: [
          {
            operation: "gmail.drafts.create",
            status: "succeeded",
            draftId: "r-1",
            messageId: "m-1",
            threadId: "t-1",
          },
        ],
      },
    ])
    expect(await window()).toBe(300)
    await stagingWork(deploymentId, "answer", second, {
      text: "y".repeat(30000),
      citations: [],
      insufficientEvidence: true,
      model: "gpt-5.4-mini",
    })
  })

  it("reconnects the same Gmail account to allow labels, keeping its tools, and offers labels only with that permission (§68)", async () => {
    await modelReview()
    const connection = id(1501)
    await sql(
      "INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext,operations) VALUES($1,$2,$3,$4,'synthetic@example.invalid','opaque','[\"gmail.search\"]')",
      [connection, w, a, member]
    )
    await actor()
    const list = async () =>
      (
        (await gmailCommand("list", { agentId: a })).connections as Record<
          string,
          unknown
        >[]
      )[0]!
    expect(await list()).toMatchObject({ canLabel: false })
    await expect(
      gmailCommand("permissions", {
        agentId: a,
        connectionId: connection,
        operations: ["gmail.search", "gmail.labels.apply"],
      })
    ).rejects.toThrow()
    // A grant frozen with labels loses them on an account without the permission.
    const usable = async () =>
      (
        await sql("SELECT agentonic.gmail_tools_usable($1::jsonb) t", [
          JSON.stringify([
            {
              connectionId: connection,
              operations: ["gmail.search", "gmail.labels.apply"],
            },
            { capability: "web", operations: ["web.search"] },
          ]),
        ])
      ).rows[0] as { t: unknown }
    expect((await usable()).t).toEqual([
      { connectionId: connection, operations: ["gmail.search"] },
      { capability: "web", operations: ["web.search"] },
    ])
    // Reconnecting refreshes the same connection, same account only.
    const reconnect = async (state: string, account: string) => {
      await actor()
      await gmailCommand("oauth.start", {
        agentId: a,
        connectionId: id(Number(state.slice(-4))),
        reconnect: connection,
        state,
        verifier: "opaque",
      })
      expect(await gmailCommand("oauth.consume", { state })).toMatchObject({
        connectionId: connection,
      })
      return gmailCommand("oauth.finish", {
        state,
        account,
        credential: "opaque-new",
        canLabel: true,
      })
    }
    await expect(
      reconnect("b".repeat(60) + "1502", "other@example.invalid")
    ).rejects.toThrow()
    await reconnect("c".repeat(60) + "1503", "Synthetic@example.invalid")
    expect(await list()).toMatchObject({
      id: connection,
      status: "connected",
      canLabel: true,
      operations: ["gmail.search"],
    })
    await gmailCommand("permissions", {
      agentId: a,
      connectionId: connection,
      operations: ["gmail.search", "gmail.labels.apply"],
    })
    expect((await usable()).t).toEqual([
      {
        connectionId: connection,
        operations: ["gmail.search", "gmail.labels.apply"],
      },
      { capability: "web", operations: ["web.search"] },
    ])
  })

  it("shows a batch turn's answer as it is written, and clears it once answered (§68)", async () => {
    const deploymentId = await running()
    const conversation = await chat("start", {
      deploymentId,
      title: "Synthetic stream",
    })
    await chat("turn", {
      conversationId: conversation.id,
      requestId: id(1510),
      query: "Resume mis correos",
      model: "gpt-5.4-mini",
      reasoning: "medium",
    })
    const job = (await stagingWork(deploymentId, "claim")) as unknown as Job
    // Earlier runtimes don't stream.
    await expect(
      stagingWork(deploymentId, "partial", job, { text: "Hola" })
    ).rejects.toMatchObject({ code: "42501" })
    await batchRuntime()
    await stagingWork(deploymentId, "partial", job, { text: "Hola, aquí" })
    await actor()
    expect(
      await chat("state", { conversationId: conversation.id })
    ).toMatchObject({
      turns: [{ status: "running", partial: "Hola, aquí", answer: null }],
    })
    await stagingWork(deploymentId, "answer", job, {
      text: "Hola, aquí está el resumen.",
      citations: [],
      insufficientEvidence: true,
      model: "gpt-5.4-mini",
    })
    await actor()
    const done = (
      (await chat("state", { conversationId: conversation.id })) as {
        turns: Record<string, unknown>[]
      }
    ).turns[0]!
    expect(done).toMatchObject({
      status: "succeeded",
      answer: "Hola, aquí está el resumen.",
      partial: null,
    })
    expect(
      (
        await sql(
          "SELECT partial_answer FROM agentonic.staging_turns WHERE id=$1",
          [job.id]
        )
      ).rows
    ).toEqual([{ partial_answer: null }])
  })

  it("keeps a chat turn's steps, refuses malformed ones and scrubs them with the conversation (§74)", async () => {
    const { turnStepTool } =
      await import("../packages/contracts/src/turn-steps")
    const deploymentId = await running()
    const conversation = await chat("start", {
      deploymentId,
      title: "Synthetic steps",
    })
    await chat("turn", {
      conversationId: conversation.id,
      requestId: id(1520),
      query: "Busca los correos de Ana",
      model: "gpt-5.4-mini",
      reasoning: "medium",
    })
    const job = (await stagingWork(deploymentId, "claim")) as unknown as Job
    // Every tool the contract names is a valid step, on any runtime.
    const steps = turnStepTool.options.map((tool, n) => ({
      tool,
      target: n % 2 ? null : "from:ana newer_than:7d",
      count: n % 3 ? null : n,
      status: (["running", "done", "proposed", "failed"] as const)[n % 4],
    }))
    await stagingWork(deploymentId, "steps", job, { steps })
    const step = {
      tool: "gmail.search",
      target: "from:ana",
      count: 8,
      status: "done",
    }
    for (const bad of [
      null,
      { tool: "gmail.search" },
      [{ ...step, extra: true }],
      [{ ...step, tool: "gmail.forward" }],
      [{ ...step, status: "skipped" }],
      [{ ...step, target: "x".repeat(201) }],
      [{ ...step, target: 3 }],
      [{ ...step, count: 1.5 }],
      [{ ...step, count: -1 }],
      [{ ...step, count: "8" }],
      Array.from({ length: 41 }, () => step),
    ])
      await expect(
        stagingWork(deploymentId, "steps", job, { steps: bad })
      ).rejects.toMatchObject({ code: "42501" })
    await stagingWork(deploymentId, "steps", job, { steps: [step] })
    await actor()
    expect(
      await chat("state", { conversationId: conversation.id })
    ).toMatchObject({ turns: [{ status: "running", steps: [step] }] })
    await stagingWork(deploymentId, "answer", job, {
      text: "Ana te escribió dos veces.",
      citations: [],
      insufficientEvidence: true,
      model: "gpt-5.4-mini",
    })
    // An answered turn keeps its steps, and its lease no longer writes them.
    await expect(
      stagingWork(deploymentId, "steps", job, { steps: [] })
    ).rejects.toMatchObject({ code: "42501" })
    await actor()
    expect(
      await chat("state", { conversationId: conversation.id })
    ).toMatchObject({ turns: [{ status: "succeeded", steps: [step] }] })
    await actor()
    await chat("close", { conversationId: conversation.id })
    expect(
      (
        await sql("SELECT steps FROM agentonic.staging_turns WHERE id=$1", [
          job.id,
        ])
      ).rows
    ).toEqual([{ steps: null }])
  })

  it("finds the owner's accepted style guide in the version's own sources (§68)", async () => {
    await modelReview()
    const object = await upload()
    const job = await claim()
    await publish(job, "Saluda con «Hola» y firma como Nico. Frases cortas.")
    const source = (
      (
        await sql(
          "SELECT doc.source_id FROM agentonic.documents doc JOIN agentonic.document_versions v ON v.document_id=doc.id WHERE v.object_id=$1",
          [object]
        )
      ).rows[0] as { source_id: string }
    ).source_id
    await sql(
      "INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext) VALUES($1,$2,$3,$4,'synthetic@example.invalid','opaque')",
      [id(1520), w, a, member]
    )
    await sql(
      "INSERT INTO agentonic.style_guides(workspace_id,agent_id,connection_id,member_id,request_id,status,budget_usd,consent,object_id) VALUES($1,$2,$3,$4,$5,'accepted',0.5,'{}',$6)",
      [w, a, id(1520), member, id(1521), object]
    )
    const guide = async (sources: string[]) =>
      (
        (
          await sql("SELECT agentonic.agent_style_guide($1,$2::jsonb) g", [
            a,
            JSON.stringify({
              collections: [{ sources: sources.map((s) => ({ id: s })) }],
            }),
          ])
        ).rows[0] as { g: string | null }
      ).g
    expect(await guide([source])).toBe(
      "Saluda con «Hola» y firma como Nico. Frases cortas."
    )
    // A version whose knowledge doesn't hold that source doesn't get it.
    expect(await guide([id(1522)])).toBeNull()
  })

  it("adds the 10-email case for a mail agent on a batch runtime, only when the evaluator can run it", async () => {
    await sql(
      "INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext,operations) VALUES($1,$2,$3,$4,'synthetic@example.invalid','opaque','[\"gmail.search\",\"gmail.read\",\"gmail.drafts.create\"]')",
      [id(1410), w, a, member]
    )
    requested.tools = [
      {
        connectionId: id(1410),
        operations: ["gmail.search", "gmail.read", "gmail.drafts.create"],
      },
    ]
    const p = await modelReview()
    const evaluator = async (verification: string) => {
      await sql(
        "UPDATE agentonic.evaluation_workers SET retired_at=clock_timestamp() WHERE database_role='agentonic_eval_azure' AND retired_at IS NULL"
      )
      await sql(
        `WITH w AS (INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,verified_at,verification) VALUES('agentonic_eval_azure','azure_staging',md5(random()::text)||md5(random()::text),now(),'${verification}') RETURNING id) INSERT INTO agentonic.evaluation_worker_runtimes(worker_id,runtime_sha256) SELECT id,repeat('b',64) FROM w`
      )
    }
    const keys = async (requestId: string) => {
      await sql(
        "UPDATE agentonic.evaluation_runs SET status='error',lease_token=NULL,lease_until=NULL WHERE preparation_id=$1 AND status IN ('queued','running')",
        [p.preparationId]
      )
      await sql(
        "UPDATE agentonic.evaluation_preparations SET status='criteria_ready' WHERE id=$1",
        [p.preparationId]
      )
      await actor()
      expect(
        await flow("run", {
          preparationId: p.preparationId,
          revision: 1,
          models: [{ model: "gpt-5.4-mini", reasoning: "medium" }],
          budgetUsd: 3,
          consent: true,
          requestId,
        })
      ).toMatchObject({ ok: true })
      return (
        (
          await sql(
            "SELECT (SELECT jsonb_agg(c->>'key') FROM jsonb_array_elements(dataset_snapshot) c) keys FROM agentonic.evaluation_runs WHERE preparation_id=$1 ORDER BY created_at DESC LIMIT 1",
            [p.preparationId]
          )
        ).rows[0] as { keys: string[] }
      ).keys
    }
    const base =
      '"reviewProtocol":3,"toolFixtures":1,"isolation":true,"recovery":true,"artifactIntegrity":true'
    // A batch evaluator, but the version's runtime is not a batch runtime.
    await evaluator(`{${base},"batchFixtures":1}`)
    expect(await keys(id(1411))).not.toContain("platform-gmail-batch")
    // A batch runtime, but an evaluator without batch fixtures.
    await batchRuntime()
    await evaluator(`{${base}}`)
    expect(await keys(id(1412))).not.toContain("platform-gmail-batch")
    // Both: the case is added, with its 10 synthetic emails.
    await evaluator(`{${base},"batchFixtures":1}`)
    expect((await keys(id(1413))).at(-1)).toBe("platform-gmail-batch")
    const batch = (
      await sql(
        "SELECT c FROM agentonic.evaluation_runs r,jsonb_array_elements(r.dataset_snapshot) c WHERE r.preparation_id=$1 AND c->>'key'='platform-gmail-batch' ORDER BY r.created_at DESC LIMIT 1",
        [p.preparationId]
      )
    ).rows[0] as { c: { fixtures: { mailbox: unknown[] } } }
    expect(batch.c.fixtures.mailbox).toHaveLength(10)
  })
})

it("model batches separate confirmation from paid runs, enforce scope and preserve repeated history", async () => {
  const p = await modelReview()
  expect(
    (
      await sql(
        "SELECT count(*)::int n FROM agentonic.evaluation_runs WHERE preparation_id=$1",
        [p.preparationId]
      )
    ).rows
  ).toEqual([{ n: 0 }])
  const payload = {
    preparationId: p.preparationId,
    revision: 1,
    models: [
      { model: "gpt-5.4", reasoning: "low" },
      { model: "gpt-6-astra", reasoning: "high" },
    ],
    budgetUsd: 3,
    consent: true,
    requestId: id(990),
  }
  await actor(other, otherW)
  await expect(flow("run", payload)).rejects.toMatchObject({ code: "42501" })
  await actor()
  const batch = await flow("run", payload)
  expect(batch.ok).toBe(true)
  expect(await flow("run", payload)).toEqual(batch)
  expect(await flow("run", { ...payload, requestId: id(991) })).toMatchObject({
    ok: false,
    code: "busy",
  })
  expect(
    await flow("save", {
      preparationId: p.preparationId,
      revision: 1,
      criteria: p.criteria,
    })
  ).toMatchObject({ ok: false, code: "busy" })
  const claimedModel = await evalClaim()
  await finishFlow(claimedModel!, "passed", true, "gpt-5.4")
  expect(
    (
      await sql("SELECT status FROM agentonic.agent_submissions WHERE id=$1", [
        p.submissionId,
      ])
    ).rows
  ).toEqual([{ status: "submitted" }])
  const second = (await evalClaim())!
  const context = await execute(second, "context")
  expect(context).toMatchObject({
    previewModel: "gpt-6-astra",
    reasoningLevel: "high",
  })
  await execute(second, "fail", { code: "provider_unavailable" })
  await actor()
  const state = await db.query<{
    result: {
      preparations: { canRun: boolean; batches: { models: unknown[] }[] }[]
    }
  }>("SELECT agentonic.review_flow_state($1) result", [a])
  expect(state.rows[0]!.result.preparations[0]).toMatchObject({ canRun: true })
  expect(
    state.rows[0]!.result.preparations[0]!.batches[0]!.models
  ).toHaveLength(2)
  expect(await flow("run", { ...payload, requestId: id(991) })).toMatchObject({
    ok: true,
  })
  expect(
    (
      await sql(
        "SELECT count(*)::int n FROM agentonic.evaluation_batches WHERE preparation_id=$1",
        [p.preparationId]
      )
    ).rows
  ).toEqual([{ n: 2 }])
})
it("model review permits editing and rerunning after success without rewriting the original evidence", async () => {
  const p = await modelReview()
  const payload = {
    preparationId: p.preparationId,
    revision: 1,
    models: [{ model: "gpt-5.4-mini", reasoning: "medium" }],
    budgetUsd: 3,
    consent: true,
    requestId: id(992),
  }
  await actor()
  await flow("run", payload)
  const job = (await evalClaim())!
  await finishFlow(job, "passed", true, "gpt-5.4-mini")
  expect(
    (
      await sql("SELECT status FROM agentonic.agent_submissions WHERE id=$1", [
        p.submissionId,
      ])
    ).rows
  ).toEqual([{ status: "approved" }])
  const before = (
    await sql(
      "SELECT dataset_snapshot, evidence_sha256, committed_microusd FROM agentonic.evaluation_runs WHERE id=$1",
      [job.id]
    )
  ).rows
  await actor()
  expect(
    await flow("save", {
      preparationId: p.preparationId,
      revision: 1,
      criteria: p.criteria.map((c) => ({
        ...c,
        expectedAnswer:
          "The warranty lasts three years; describe the duration clearly.",
        reviewDecision: "approved",
      })),
    })
  ).toMatchObject({ ok: true })
  expect(
    await flow("run", { ...payload, revision: 2, requestId: id(993) })
  ).toMatchObject({ ok: false, code: "criteria_required" })
  await flow("confirm", {
    preparationId: p.preparationId,
    revision: 2,
    consent: true,
  })
  expect(
    await flow("run", { ...payload, revision: 2, requestId: id(993) })
  ).toMatchObject({ ok: true })
  expect(
    (
      await sql(
        "SELECT dataset_snapshot, evidence_sha256, committed_microusd FROM agentonic.evaluation_runs WHERE id=$1",
        [job.id]
      )
    ).rows
  ).toEqual(before)
})
it("model review validates levels, caps cumulative batch reservations and cancels every model", async () => {
  const p = await modelReview()
  const payload = {
    preparationId: p.preparationId,
    revision: 1,
    models: [{ model: "gpt-6-astra", reasoning: "none" }],
    budgetUsd: 0.1,
    consent: true,
    requestId: id(994),
  }
  await expect(flow("run", payload)).rejects.toMatchObject({ code: "42501" })
  const choices = [
    { model: "gpt-5.4-mini", reasoning: "medium" },
    { model: "gpt-5.4", reasoning: "high" },
  ]
  await flow("run", { ...payload, models: choices })
  const job = (await evalClaim())!
  expect(
    await execute(job, "reserve", {
      id: id(995),
      provider: "openai",
      model: choices[0]!.model,
      microusd: 60000,
    })
  ).toMatchObject({ ok: true })
  await execute(job, "fail", { code: "provider_unavailable" })
  const next = (await evalClaim())!
  expect(
    await execute(next, "reserve", {
      id: id(996),
      provider: "openai",
      model: choices[1]!.model,
      microusd: 60000,
    })
  ).toMatchObject({ ok: false, code: "budget_exhausted" })
  await actor()
  await flow("cancel", { preparationId: p.preparationId })
  expect(
    (
      await sql(
        "SELECT count(*)::int n FROM agentonic.evaluation_runs WHERE preparation_id=$1 AND consent_revoked_at IS NOT NULL",
        [p.preparationId]
      )
    ).rows
  ).toEqual([{ n: 2 }])
  expect(
    (
      await sql(
        "SELECT committed_microusd FROM agentonic.evaluation_preparations WHERE id=$1",
        [p.preparationId]
      )
    ).rows
  ).toEqual([{ committed_microusd: 60500 }])
})
it("model review approvals expose only the approved models and levels in live chats and staff receipts", async () => {
  const p = await modelReview()
  const models = [
    { model: "gpt-5.4-mini", reasoning: "medium" },
    { model: "gpt-6-astra", reasoning: "low" },
  ]
  await flow("run", {
    preparationId: p.preparationId,
    revision: 1,
    models,
    budgetUsd: 3,
    consent: true,
    requestId: id(980),
  })
  for (const configuration of models)
    await finishFlow((await evalClaim())!, "passed", true, configuration.model)
  await actor(staff, w, "agentonic_admin")
  const report = await receipt(p.submissionId)
  if (!report) throw new Error("Expected authorized receipt")
  expect(report.modelBatch?.models).toHaveLength(2)
  expect(report.criteria).toHaveLength(1)
  await sql(
    "WITH h AS (INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,verified_at,heartbeat_at) VALUES('local','agentonic_deployer_local',repeat('f',64),clock_timestamp(),clock_timestamp()) RETURNING id), b AS (INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256) SELECT id,repeat('f',64) FROM h) INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) SELECT id,repeat('b',64) FROM h"
  )
  await actor()
  const d = await lifecycleCall("deployment_command", "authorize", {
    submissionId: p.submissionId,
    environment: "local",
    budgetUsd: 0.25,
    consent: true,
    requestId: id(981),
  })
  expect(d.ok).toBe(true)
  const deploymentId = String(d.id)
  await readyStaging({ ...p, deploymentId })
  await actor()
  const conversation = await chat("start", {
    deploymentId,
    title: "Synthetic model chat",
  })
  expect(
    await chat("state", { conversationId: conversation.id })
  ).toMatchObject({ models })
  await db.exec("SAVEPOINT unapproved_model")
  await expect(
    chat("turn", {
      conversationId: conversation.id,
      query: "Synthetic question",
      requestId: id(982),
      model: "gpt-6-astra",
      reasoning: "high",
    })
  ).rejects.toMatchObject({ code: "42501" })
  await db.exec(
    "ROLLBACK TO SAVEPOINT unapproved_model; RELEASE SAVEPOINT unapproved_model"
  )
  expect(
    await chat("turn", {
      conversationId: conversation.id,
      query: "Synthetic question",
      requestId: id(982),
      ...models[1],
    })
  ).toMatchObject({ ok: true })
  expect(
    await chat("turn", {
      conversationId: conversation.id,
      query: "Synthetic question",
      requestId: id(982),
      ...models[0],
    })
  ).toMatchObject({ ok: false, code: "request_conflict" })
  const job = (await stagingWork(deploymentId, "claim")) as unknown as Job
  expect(await stagingWork(deploymentId, "context", job)).toMatchObject({
    previewModel: "gpt-6-astra",
    reasoningLevel: "low",
  })
})
it("serves several frozen runtimes side by side and never retires one a deployment uses", async () => {
  const p = await modelReview()
  // The registration made before the migration kept its runtime.
  expect(
    (
      await sql(
        "SELECT count(*)::int n FROM agentonic.evaluation_worker_runtimes r JOIN agentonic.evaluation_workers ew ON ew.id=r.worker_id WHERE ew.revoked_at IS NOT NULL AND r.runtime_sha256=repeat('b',64)"
      )
    ).rows[0]
  ).toEqual({ n: 1 })
  const models = [{ model: "gpt-5.4-mini", reasoning: "medium" }]
  await actor()
  await flow("run", {
    preparationId: p.preparationId,
    revision: 1,
    models,
    budgetUsd: 3,
    consent: true,
    requestId: id(990),
  })
  for (const configuration of models)
    await finishFlow((await evalClaim())!, "passed", true, configuration.model)
  // A host that only has a newer runtime cannot run this candidate.
  const host = (
    await sql(
      "INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,verified_at,heartbeat_at) VALUES('local','agentonic_deployer_local',repeat('f',64),clock_timestamp(),clock_timestamp()) RETURNING id"
    )
  ).rows[0] as { id: string }
  await sql(
    "INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256) VALUES($1,repeat('f',64))",
    [host.id]
  )
  await sql(
    "INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) VALUES($1,repeat('c',64))",
    [host.id]
  )
  const authorize = async (n: number) => {
    await actor()
    return lifecycleCall("deployment_command", "authorize", {
      submissionId: p.submissionId,
      environment: "local",
      budgetUsd: 0.25,
      consent: true,
      requestId: id(n),
    })
  }
  await expect(authorize(991)).rejects.toMatchObject({ code: "42501" })
  // Installing the pinned runtime next to the newer one makes it available.
  await sql(
    "INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) VALUES($1,repeat('b',64))",
    [host.id]
  )
  const d = await authorize(992)
  expect(d.ok).toBe(true)
  await readyStaging({ ...p, deploymentId: String(d.id) })
  await db.exec("SAVEPOINT retire")
  await expect(
    sql(
      "UPDATE agentonic.runtime_host_artifacts SET retired_at=clock_timestamp() WHERE runtime_sha256=repeat('b',64)"
    )
  ).rejects.toThrow("Runtime in use")
  await db.exec("ROLLBACK TO SAVEPOINT retire")
  await sql(
    "UPDATE agentonic.runtime_host_artifacts SET retired_at=clock_timestamp() WHERE runtime_sha256=repeat('c',64)"
  )
  for (const statement of [
    "UPDATE agentonic.runtime_host_artifacts SET retired_at=NULL WHERE runtime_sha256=repeat('c',64)",
    "UPDATE agentonic.runtime_host_artifacts SET runtime_sha256=repeat('d',64) WHERE runtime_sha256=repeat('b',64)",
    "DELETE FROM agentonic.runtime_host_artifacts",
    "UPDATE agentonic.evaluation_worker_runtimes SET runtime_sha256=repeat('d',64)",
    "DELETE FROM agentonic.evaluation_worker_runtimes",
  ]) {
    await db.exec("SAVEPOINT immutable")
    await expect(sql(statement)).rejects.toThrow()
    await db.exec("ROLLBACK TO SAVEPOINT immutable")
  }
  // Application roles never read the registration lists directly.
  await actor()
  await db.exec("SAVEPOINT direct")
  await expect(
    db.query("SELECT * FROM agentonic.runtime_host_artifacts")
  ).rejects.toThrow()
  await db.exec("ROLLBACK TO SAVEPOINT direct")
})
const brokers = { f: "f".repeat(64), e: "e".repeat(64), d: "d".repeat(64) }
async function callAs(role: string, query: string, params: unknown[]) {
  await db.exec(`RESET ROLE;SET LOCAL ROLE ${role};SAVEPOINT copy_call`)
  try {
    const r = await db.query<{ result: Record<string, unknown> | null }>(
      query,
      params
    )
    await db.exec("RELEASE SAVEPOINT copy_call")
    return r.rows[0]!.result
  } catch (e) {
    await db.exec("ROLLBACK TO SAVEPOINT copy_call;RELEASE SAVEPOINT copy_call")
    throw e
  }
}
const controller = (
  broker: string,
  operation: string,
  deploymentId: string | null,
  secret = serviceSecret
) =>
  callAs(
    "agentonic_deployer_local",
    "SELECT agentonic.deployment_host($1,$2,jsonb_build_object('brokerHash',$3::text,'tokenHash',encode(sha256(convert_to($4,'UTF8')),'hex'))) result",
    [operation, deploymentId, broker, secret]
  )
const copy = (
  operation: string,
  deploymentId: string,
  secret: string,
  payload: Record<string, unknown> = {}
) =>
  callAs(
    "agentonic_runtime_local",
    "SELECT agentonic.deployment_service($1,$2,$3,$4) result",
    [operation, deploymentId, secret, JSON.stringify(payload)]
  )
const work = (
  deploymentId: string,
  secret: string,
  operation: string,
  job: Job | null = null,
  payload: Record<string, unknown> = {}
) =>
  callAs(
    "agentonic_runtime_local",
    "SELECT agentonic.staging_worker($1,$2,$3,$4,$5,$6) result",
    [
      operation,
      deploymentId,
      secret,
      job?.id ?? null,
      job?.token ?? null,
      JSON.stringify(payload),
    ]
  )
async function rejectsSql(statement: string, params: unknown[] = []) {
  await db.exec("SAVEPOINT rejected_sql")
  await expect(sql(statement, params)).rejects.toThrow()
  await db.exec("ROLLBACK TO SAVEPOINT rejected_sql")
}
async function installBroker(hostId: string, broker: string) {
  await sql(
    "INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256) VALUES($1,$2)",
    [hostId, broker]
  )
  await sql("UPDATE agentonic.runtime_hosts SET broker_sha256=$2 WHERE id=$1", [
    hostId,
    broker,
  ])
}
const brokerLive = async (broker: string) =>
  (
    await sql(
      "SELECT retired_at IS NULL AND revoked_at IS NULL live FROM agentonic.runtime_host_brokers WHERE broker_sha256=$1",
      [broker]
    )
  ).rows[0]
/** A running staging deployment whose serving copy runs broker f, with one leased turn. */
async function servingOnBroker() {
  const p = await modelReview()
  const model = { model: "gpt-5.4-mini", reasoning: "medium" }
  await actor()
  await flow("run", {
    preparationId: p.preparationId,
    revision: 1,
    models: [model],
    budgetUsd: 3,
    consent: true,
    requestId: id(990),
  })
  await finishFlow((await evalClaim())!, "passed", true, model.model)
  const hostId = (
    (
      await sql(
        "WITH h AS (INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,verified_at,heartbeat_at) VALUES('local','agentonic_deployer_local',repeat('f',64),clock_timestamp(),clock_timestamp()) RETURNING id), b AS (INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256) SELECT id,repeat('f',64) FROM h), r AS (INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) SELECT id,repeat('b',64) FROM h) SELECT id FROM h"
      )
    ).rows[0] as { id: string }
  ).id
  await actor()
  const d = await lifecycleCall("deployment_command", "authorize", {
    submissionId: p.submissionId,
    environment: "local",
    budgetUsd: 0.25,
    consent: true,
    requestId: id(992),
  })
  const deploymentId = String(d.id)
  await readyStaging({ ...p, deploymentId })
  await actor()
  const conversation = await chat("start", {
    deploymentId,
    title: "Synthetic broker move",
  })
  const ask = async (n: number) => {
    await actor()
    expect(
      await chat("turn", {
        conversationId: conversation.id,
        query: "Synthetic question",
        requestId: id(n),
        ...model,
      })
    ).toMatchObject({ ok: true })
  }
  await ask(982)
  const leased = (await work(deploymentId, serviceSecret, "claim")) as Job
  expect(leased).toMatchObject({ kind: "retrieve" })
  return { deploymentId, hostId, leased, ask }
}
it("moves a running deployment to a new broker while the old copy finishes its leased turn", async () => {
  const { deploymentId: dep, hostId, leased } = await servingOnBroker()
  const next = "b".repeat(64)
  await installBroker(hostId, brokers.e)
  // Only the current broker's controller is accepted; it sees every registered broker.
  await expect(controller(brokers.f, "poll", null)).rejects.toMatchObject({
    code: "42501",
  })
  const polled = await controller(brokers.e, "poll", null)
  expect(polled!.brokers).toEqual([
    { sha256: brokers.f, live: true },
    { sha256: brokers.e, live: true },
  ])
  expect(polled!.deployments).toEqual([
    expect.objectContaining({
      id: dep,
      broker: brokers.f,
      successorBroker: null,
      drainingBroker: null,
    }),
  ])
  const moved = (await controller(brokers.e, "move", dep, next))!
  expect(moved).toMatchObject({ ok: true, manifestHash: expect.any(String) })
  await expect(controller(brokers.e, "move", dep, next)).rejects.toThrow()
  // A starting successor cannot work and must run the broker it was assigned.
  await expect(work(dep, next, "claim")).rejects.toMatchObject({
    code: "42501",
  })
  await expect(copy("rest", dep, next)).rejects.toMatchObject({
    code: "42501",
  })
  expect(await copy("heartbeat", dep, next)).toEqual({ ok: true })
  await expect(
    copy("ready", dep, next, {
      manifestHash: moved.manifestHash,
      brokerHash: brokers.f,
    })
  ).rejects.toMatchObject({ code: "42501" })
  expect(
    await copy("ready", dep, next, {
      manifestHash: moved.manifestHash,
      brokerHash: brokers.e,
    })
  ).toEqual({ ok: true })
  // The replaced copy drains: it finishes its leased turn and claims nothing new,
  // even with another conversation's turn waiting.
  expect(await copy("heartbeat", dep, serviceSecret)).toEqual({
    ok: true,
    draining: true,
  })
  await expect(copy("rest", dep, serviceSecret)).rejects.toMatchObject({
    code: "42501",
  })
  await actor()
  const second = await chat("start", {
    deploymentId: dep,
    title: "Synthetic second chat",
  })
  expect(
    await chat("turn", {
      conversationId: second.id,
      query: "Synthetic question",
      requestId: id(984),
      model: "gpt-5.4-mini",
      reasoning: "medium",
    })
  ).toMatchObject({ ok: true })
  await expect(
    copy("ready", dep, serviceSecret, { manifestHash: moved.manifestHash })
  ).rejects.toMatchObject({ code: "42501" })
  expect(await work(dep, serviceSecret, "heartbeat", leased)).toEqual({
    ok: true,
  })
  expect(await work(dep, serviceSecret, "claim")).toBeNull()
  expect(
    await work(dep, serviceSecret, "fail", leased, {
      code: "provider_unavailable",
    })
  ).toEqual({ ok: true })
  expect(await work(dep, next, "claim")).toMatchObject({ kind: "retrieve" })
  // The earlier broker stays live while its copy drains, then retires.
  await controller(brokers.e, "poll", null)
  expect(await brokerLive(brokers.f)).toEqual({ live: true })
  expect(await controller(brokers.e, "drained", dep)).toEqual({ ok: true })
  await expect(copy("heartbeat", dep, serviceSecret)).rejects.toMatchObject({
    code: "42501",
  })
  await controller(brokers.e, "poll", null)
  expect(await brokerLive(brokers.f)).toEqual({ live: false })
  expect(
    (
      await sql(
        "SELECT broker_sha256,draining_token_sha256 FROM agentonic.deployments WHERE id=$1",
        [dep]
      )
    ).rows
  ).toEqual([{ broker_sha256: brokers.e, draining_token_sha256: null }])
  expect(
    (
      await sql(
        "SELECT count(*)::int n FROM agentonic.audit_events WHERE action='deployment.broker_moved' AND resource_id=$1",
        [dep]
      )
    ).rows
  ).toEqual([{ n: 1 }])
  // Already on the current broker: nothing to move.
  await expect(
    controller(brokers.e, "move", dep, "c".repeat(64))
  ).rejects.toMatchObject({ code: "42501" })
})
it("rests an idle copy, keeps it available through its controller and wakes it for a waiting turn", async () => {
  const { deploymentId: dep, leased, ask } = await servingOnBroker()
  const watched = async () =>
    (await controller(brokers.f, "watch", null))!.deployments
  const chatState = async (conversationId: string) => {
    await actor()
    return chat("state", { conversationId })
  }
  const conversationId = (
    (
      await sql(
        "SELECT conversation_id FROM agentonic.staging_turns WHERE id=$1",
        [leased.id]
      )
    ).rows[0] as { conversation_id: string }
  ).conversation_id
  expect(
    await work(dep, serviceSecret, "fail", leased, { code: "lease_lost" })
  ).toEqual({ ok: true })
  // Only the serving copy may rest.
  await expect(copy("rest", dep, "9".repeat(64))).rejects.toMatchObject({
    code: "42501",
  })
  expect(await copy("rest", dep, serviceSecret)).toEqual({ ok: true })
  // Long after its copy last reported, a resting deployment stays available
  // while its controller reports: chats can still send turns.
  await sql(
    "UPDATE agentonic.deployments SET heartbeat_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
    [dep]
  )
  expect(await watched()).toEqual([
    expect.objectContaining({ id: dep, resting: true, pending: false }),
  ])
  expect(await chatState(conversationId)).toMatchObject({ online: true })
  await ask(983)
  expect(await watched()).toEqual([
    expect.objectContaining({ id: dep, resting: true, pending: true }),
  ])
  // A copy cannot rest while a turn waits for it.
  expect(await copy("rest", dep, serviceSecret)).toEqual({
    ok: false,
    code: "pending",
  })
  // Waking vouches for the starting copy for one heartbeat interval only.
  expect(await controller(brokers.f, "wake", dep)).toEqual({ ok: true })
  expect(await watched()).toEqual([
    expect.objectContaining({ id: dep, resting: false, pending: true }),
  ])
  expect(await copy("heartbeat", dep, serviceSecret)).toEqual({ ok: true })
  const job = (await work(dep, serviceSecret, "claim")) as Job
  expect(job).toMatchObject({ kind: "retrieve" })
  expect(await watched()).toEqual([
    expect.objectContaining({ resting: false, pending: false }),
  ])
  expect(
    await work(dep, serviceSecret, "fail", job, { code: "lease_lost" })
  ).toEqual({ ok: true })
  // Without a reporting controller nobody would start the copy: offline.
  expect(await copy("rest", dep, serviceSecret)).toEqual({ ok: true })
  await sql(
    "UPDATE agentonic.deployments SET heartbeat_at=clock_timestamp()-interval '10 minutes' WHERE id=$1",
    [dep]
  )
  await sql(
    "UPDATE agentonic.runtime_hosts SET heartbeat_at=clock_timestamp()-interval '2 minutes'"
  )
  expect(await chatState(conversationId)).toMatchObject({ online: false })
  await actor()
  expect(
    await chat("turn", {
      conversationId,
      query: "Synthetic question",
      requestId: id(985),
      model: "gpt-5.4-mini",
      reasoning: "medium",
    })
  ).toEqual({ ok: false, code: "offline" })
  await controller(brokers.f, "watch", null)
  expect(await chatState(conversationId)).toMatchObject({ online: true })
  // A copy that reports is awake, however it was started.
  expect(await copy("heartbeat", dep, serviceSecret)).toEqual({ ok: true })
  expect(await watched()).toEqual([
    expect.objectContaining({ id: dep, resting: false }),
  ])
  // A waiting turn whose authority lapsed between full polls wakes nothing.
  expect(await copy("rest", dep, serviceSecret)).toEqual({ ok: true })
  await ask(986)
  expect(await watched()).toEqual([
    expect.objectContaining({ id: dep, resting: true, pending: true }),
  ])
  await sql("ALTER TABLE agentonic.deployments DISABLE TRIGGER USER")
  await sql(
    "UPDATE agentonic.deployments SET authorized_until=created_at+interval '1 millisecond' WHERE id=$1",
    [dep]
  )
  await sql("ALTER TABLE agentonic.deployments ENABLE TRIGGER USER")
  expect(await watched()).toEqual([
    expect.objectContaining({ id: dep, status: "running", pending: false }),
  ])
  // Between full polls the controller lists only active deployments; a
  // deployment that ended appears in the next full poll, which cleans it up.
  await actor()
  expect(
    await lifecycleCall("deployment_command", "stop", { deploymentId: dep })
  ).toMatchObject({ ok: true })
  expect(await watched()).toEqual([])
  expect((await controller(brokers.f, "poll", null))!.deployments).toEqual([
    expect.objectContaining({ id: dep, status: "stopped", resting: false }),
  ])
  await expect(controller(brokers.f, "wake", dep)).rejects.toMatchObject({
    code: "42501",
  })
})
it("refuses a revoked broker's copies at once, restores them and ends every copy on stop", async () => {
  const { deploymentId: dep, hostId, leased } = await servingOnBroker()
  const next = "b".repeat(64),
    restored = "c".repeat(64),
    later = "9".repeat(64)
  await installBroker(hostId, brokers.e)
  // An abandoned move leaves the serving copy in place.
  await controller(brokers.e, "move", dep, next)
  expect(await controller(brokers.e, "abandon", dep)).toEqual({ ok: true })
  await expect(copy("heartbeat", dep, next)).rejects.toMatchObject({
    code: "42501",
  })
  expect(await copy("heartbeat", dep, serviceSecret)).toEqual({ ok: true })
  // Retiring a broker in use is refused; revocation is the emergency path.
  await rejectsSql(
    "UPDATE agentonic.runtime_host_brokers SET retired_at=clock_timestamp() WHERE broker_sha256=$1",
    [brokers.f]
  )
  await sql(
    "UPDATE agentonic.runtime_host_brokers SET revoked_at=clock_timestamp() WHERE broker_sha256=$1",
    [brokers.f]
  )
  await expect(copy("heartbeat", dep, serviceSecret)).rejects.toMatchObject({
    code: "42501",
  })
  await expect(
    work(dep, serviceSecret, "heartbeat", leased)
  ).rejects.toMatchObject({ code: "42501" })
  const replacement = (await controller(brokers.e, "restore", dep, restored))!
  expect(
    await copy("ready", dep, restored, {
      manifestHash: replacement.manifestHash,
      brokerHash: brokers.e,
    })
  ).toEqual({ ok: true })
  // The revoked copy's turn stays leased until it expires; nothing else is queued.
  expect(await work(dep, restored, "claim")).toBeNull()
  for (const statement of [
    "UPDATE agentonic.runtime_host_brokers SET revoked_at=NULL WHERE broker_sha256=repeat('f',64)",
    "UPDATE agentonic.runtime_host_brokers SET retired_at=clock_timestamp() WHERE broker_sha256=repeat('f',64)",
    "UPDATE agentonic.runtime_host_brokers SET revoked_at=clock_timestamp() WHERE broker_sha256=repeat('e',64)",
    "UPDATE agentonic.runtime_host_brokers SET installed_at=installed_at-interval '1 day'",
    "DELETE FROM agentonic.runtime_host_brokers",
  ])
    await rejectsSql(statement)
  // Stopping the deployment ends a move in progress with it.
  await installBroker(hostId, brokers.d)
  await controller(brokers.d, "move", dep, later)
  await actor()
  expect(
    await lifecycleCall("deployment_command", "stop", { deploymentId: dep })
  ).toMatchObject({ ok: true })
  expect(
    (
      await sql(
        "SELECT successor_token_sha256,draining_token_sha256,service_token_sha256 FROM agentonic.deployments WHERE id=$1",
        [dep]
      )
    ).rows
  ).toEqual([
    {
      successor_token_sha256: null,
      draining_token_sha256: null,
      service_token_sha256: null,
    },
  ])
  await expect(copy("heartbeat", dep, later)).rejects.toMatchObject({
    code: "42501",
  })
  // A host's current broker must be registered and live.
  await sql("SET CONSTRAINTS ALL IMMEDIATE")
  await rejectsSql(
    "UPDATE agentonic.runtime_hosts SET broker_sha256=repeat('f',64) WHERE id=$1",
    [hostId]
  )
})
it("keeps evidence from a retired evaluator registration and withdraws it on revocation", async () => {
  const p = await modelReview()
  const model = { model: "gpt-5.4-mini", reasoning: "medium" }
  await actor()
  await flow("run", {
    preparationId: p.preparationId,
    revision: 1,
    models: [model],
    budgetUsd: 3,
    consent: true,
    requestId: id(990),
  })
  await finishFlow((await evalClaim())!, "passed", true, model.model)
  const run = (
    await sql(
      "SELECT id,worker_id FROM agentonic.evaluation_runs WHERE preparation_id=$1 AND status='passed'",
      [p.preparationId]
    )
  ).rows[0] as { id: string; worker_id: string }
  const approvable = async () =>
    (
      (
        await sql(
          "SELECT agentonic.evaluation_approvable(e,true) ok FROM agentonic.evaluation_runs e WHERE id=$1",
          [run.id]
        )
      ).rows[0] as { ok: boolean }
    ).ok
  expect(await approvable()).toBe(true)
  // Renewal retires the registration: it takes no more work...
  await sql(
    "UPDATE agentonic.evaluation_workers SET retired_at=clock_timestamp() WHERE id=$1",
    [run.worker_id]
  )
  await db.exec("SAVEPOINT retired_claim")
  await expect(evalClaim()).rejects.toMatchObject({ code: "42501" })
  await db.exec("ROLLBACK TO SAVEPOINT retired_claim")
  // ...but what it produced while active stays valid for approval.
  expect(await approvable()).toBe(true)
  await sql(
    "WITH w AS (INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,verified_at,verification) VALUES('agentonic_eval_azure','azure_staging',repeat('d',64),now(),'{\"reviewProtocol\":3,\"isolation\":true,\"recovery\":true,\"artifactIntegrity\":true}') RETURNING id) INSERT INTO agentonic.evaluation_worker_runtimes(worker_id,runtime_sha256) SELECT id,repeat('b',64) FROM w"
  )
  expect(await evalClaim()).toBeNull()
  await rejectsSql(
    "UPDATE agentonic.evaluation_workers SET retired_at=NULL WHERE id=$1",
    [run.worker_id]
  )
  // Revocation withdraws trust from everything the registration produced.
  await sql(
    "UPDATE agentonic.evaluation_workers SET revoked_at=clock_timestamp() WHERE id=$1",
    [run.worker_id]
  )
  expect(await approvable()).toBe(false)
})

/** The machine side of a staging host, in memory: copy configurations and running processes. */
function machine(
  brokerHash: string,
  clock: { now: number },
  state = {
    configs: new Map<string, Record<string, string>>(),
    processes: new Set<string>(),
    log: [] as string[],
  },
  /** Brokers whose copies need a root-written drop-in this controller cannot write. */
  dropIn = new Set<string>()
) {
  let secrets = 0
  const key = (broker: string, id: string) => `${broker}:${id}`
  const system: ControllerSystem = {
    brokerHash,
    host: (operation, id, payload = {}) =>
      callAs(
        "agentonic_deployer_local",
        "SELECT agentonic.deployment_host($1,$2,$3) result",
        [operation, id, JSON.stringify({ ...payload, brokerHash })]
      ),
    brokerConfig: () => ({ AGENTONIC_BROKER_SHA256: brokerHash }),
    install: (prepared) => ({
      destination: "/instances/synthetic",
      manifestHash: (prepared as { manifestHash: string }).manifestHash,
    }),
    switchCurrent: () => {},
    removeAssets: () => {},
    configure: (broker, id, settings) => {
      if (state.configs.has(key(broker, id))) throw new Error("exists")
      state.configs.set(key(broker, id), settings)
    },
    running: (broker, id) => state.processes.has(key(broker, id)),
    startable: (broker) => !dropIn.has(broker),
    start: (broker, id) => {
      if (dropIn.has(broker)) throw new Error("broker_unavailable")
      state.processes.add(key(broker, id))
      state.log.push(`start ${broker[0]}`)
    },
    remove: (broker, id) => {
      state.processes.delete(key(broker, id))
      state.configs.delete(key(broker, id))
      state.log.push(`remove ${broker[0]}`)
    },
    secret: () => String(++secrets).repeat(64),
    now: () => clock.now,
  }
  const failures: string[] = []
  const controller = new Controller(system)
  /** One controller pass, exactly as the deployment controller runs it. */
  const pass = async (operation: "poll" | "watch" = "poll") => {
    const state_ = pollResult.parse(await controllerPoll(brokerHash, operation))
    const onDisk = new Map<string, Set<string>>()
    for (const name of state.configs.keys()) {
      const [broker, id] = name.split(":") as [string, string]
      onDisk.set(id, (onDisk.get(id) ?? new Set()).add(broker))
    }
    await controller.pass(
      state_.deployments.map((raw) => metadata.parse(raw)),
      state_.brokers,
      onDisk,
      {
        due: () => true,
        ok: () => {},
        fail: (_d, failure) => {
          failures.push(`${failure.step}:${failure.reason}`)
        },
      }
    )
  }
  return { ...state, pass, failures }
}
const controllerPoll = (broker: string, operation = "poll") =>
  controller(broker, operation, null)
const copySecret = (
  m: { configs: Map<string, Record<string, string>> },
  broker: string,
  id: string
) => m.configs.get(`${broker}:${id}`)!
it("upgrades running copies through the controller: move, drain, retire, restore, abandon, stop", async () => {
  const { deploymentId: dep, hostId, leased } = await servingOnBroker()
  const clock = { now: Date.now() }
  // The host already runs broker f's serving copy; broker e is installed next to it.
  await installBroker(hostId, brokers.e)
  const m = machine(brokers.e, clock)
  m.configs.set(`${brokers.f}:${dep}`, {
    AGENTONIC_DEPLOYMENT_SECRET: serviceSecret,
  })
  m.processes.add(`${brokers.f}:${dep}`)
  await m.pass()
  expect(m.log).toEqual(["start e"])
  // The successor reports ready; the replaced copy drains and finishes its turn.
  const successor = copySecret(m, brokers.e, dep)
  expect(
    await copy("ready", dep, successor.AGENTONIC_DEPLOYMENT_SECRET!, {
      manifestHash: successor.AGENTONIC_MANIFEST_HASH,
      brokerHash: brokers.e,
    })
  ).toEqual({ ok: true })
  await m.pass()
  expect(m.log).toEqual(["start e"])
  expect(
    await work(dep, serviceSecret, "fail", leased, { code: "lease_lost" })
  ).toEqual({ ok: true })
  expect(await copy("heartbeat", dep, serviceSecret)).toMatchObject({
    draining: true,
  })
  m.processes.delete(`${brokers.f}:${dep}`)
  await m.pass()
  expect(m.log).toEqual(["start e", "remove f"])
  await m.pass()
  expect(await brokerLive(brokers.f)).toEqual({ live: false })
  expect(m.failures).toEqual([])
  // Emergency: broker e is revoked once d is installed. The new controller restores at once.
  await installBroker(hostId, brokers.d)
  await sql(
    "UPDATE agentonic.runtime_host_brokers SET revoked_at=clock_timestamp() WHERE broker_sha256=$1",
    [brokers.e]
  )
  const n = machine(brokers.d, clock, m)
  await n.pass()
  expect(n.log.slice(2)).toEqual(["remove e", "start d"])
  const restored = copySecret(n, brokers.d, dep)
  expect(
    await copy("ready", dep, restored.AGENTONIC_DEPLOYMENT_SECRET!, {
      manifestHash: restored.AGENTONIC_MANIFEST_HASH,
      brokerHash: brokers.d,
    })
  ).toEqual({ ok: true })
  // A copy that stops right after starting is a failure; it is restarted after a pause.
  const since = (from: number) => n.log.slice(from)
  let mark = n.log.length
  n.processes.delete(`${brokers.d}:${dep}`)
  await n.pass()
  expect(since(mark)).toEqual([])
  expect(n.failures).toEqual(["start:copy_exited"])
  clock.now += 31_000
  await n.pass()
  expect(since(mark)).toEqual(["start d"])
  // A successor that never becomes ready is abandoned; the serving copy keeps serving.
  const seven = "7".repeat(64)
  await installBroker(hostId, seven)
  const o = machine(seven, clock, m)
  mark = o.log.length
  await o.pass()
  expect(since(mark)).toEqual(["start 7"])
  clock.now += 121_000
  await o.pass()
  expect(since(mark)).toEqual(["start 7", "remove 7"])
  expect(o.failures).toEqual(["move:successor_not_ready"])
  expect(
    await copy("heartbeat", dep, restored.AGENTONIC_DEPLOYMENT_SECRET!)
  ).toEqual({ ok: true })
  clock.now += 60_000
  await o.pass()
  expect(since(mark)).toEqual(["start 7", "remove 7"])
  clock.now += 10 * 60_000
  await o.pass()
  expect(since(mark)).toEqual(["start 7", "remove 7", "start 7"])
  // Stopping the deployment removes every copy.
  await actor()
  expect(
    await lifecycleCall("deployment_command", "stop", { deploymentId: dep })
  ).toMatchObject({ ok: true })
  mark = o.log.length
  await o.pass()
  expect(since(mark).sort()).toEqual(["remove 7", "remove d"])
  expect([...o.configs.keys(), ...o.processes]).toEqual([])
})

it("keeps the general conversation model in step with a staging chat", async () => {
  const { deploymentId: dep, leased } = await servingOnBroker()
  const c = (
    await sql(
      "SELECT id,agent_id FROM agentonic.staging_conversations WHERE deployment_id=$1",
      [dep]
    )
  ).rows[0] as { id: string; agent_id: string }
  const general = async () => {
    await db.exec("RESET ROLE")
    const conversation = (
      await db.query(
        "SELECT c.environment,c.title,c.deleted_at IS NOT NULL closed,e.surface,e.external_endpoint_key,k.linked_user_id FROM agentonic.conversations c JOIN agentonic.channel_endpoints e ON e.id=c.endpoint_id JOIN agentonic.contacts k ON k.id=c.owner_contact_id WHERE c.id=$1",
        [c.id]
      )
    ).rows[0]
    const runs = (
      await db.query(
        "SELECT id,status,deployment_id,preview_id,trigger_kind FROM agentonic.agent_runs WHERE conversation_id=$1 ORDER BY created_at",
        [c.id]
      )
    ).rows
    const messages = (
      await db.query<{ content: unknown; redacted: boolean }>(
        "SELECT role,sequence_number::int seq,content,redacted_at IS NOT NULL redacted FROM agentonic.messages WHERE conversation_id=$1 ORDER BY sequence_number",
        [c.id]
      )
    ).rows
    return { conversation, runs, messages }
  }
  let state = await general()
  expect(state.conversation).toEqual({
    environment: "staging",
    title: "Synthetic broker move",
    closed: false,
    surface: "web",
    external_endpoint_key: `panel:${c.agent_id}`,
    linked_user_id: owner,
  })
  // The turn and its run share one ID; the leased turn is running.
  expect(state.runs).toEqual([
    {
      id: leased.id,
      status: "running",
      deployment_id: dep,
      preview_id: null,
      trigger_kind: "message",
    },
  ])
  expect(state.messages).toEqual([
    {
      role: "user",
      seq: 1,
      content: { version: "1", text: "Synthetic question" },
      redacted: false,
    },
  ])
  await work(dep, serviceSecret, "search", leased, { embedding })
  const context = (await work(dep, serviceSecret, "context", leased))!
  const citations = (context.passages as { id: string }[]).map((x) => x.id)
  await work(dep, serviceSecret, "answer", leased, {
    text: "three years",
    citations,
    insufficientEvidence: false,
    model: "gpt-5.4-mini",
  })
  state = await general()
  expect(state.runs[0]).toMatchObject({ status: "succeeded" })
  expect(state.messages[1]).toEqual({
    role: "assistant",
    seq: 2,
    content: {
      version: "1",
      text: "three years",
      citations,
      insufficientEvidence: false,
    },
    redacted: false,
  })
  // Closing the chat erases its text from both models.
  await actor()
  expect(await chat("close", { conversationId: c.id })).toMatchObject({
    ok: true,
  })
  state = await general()
  expect(state.conversation).toMatchObject({ closed: true })
  expect(state.messages.map((m) => [m.content, m.redacted])).toEqual([
    [{ version: "1", redacted: true }, true],
    [{ version: "1", redacted: true }, true],
  ])
  // The general row is the turn's identity: it cannot be removed underneath it.
  await rejectsSql("DELETE FROM agentonic.agent_runs WHERE id=$1", [leased.id])
})

it("attributes a staging turn's spend to its run", async () => {
  const { deploymentId: dep, leased } = await servingOnBroker()
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=10000000 WHERE provider='voyage'"
  )
  await work(dep, serviceSecret, "reserve", leased, {
    id: id(960),
    provider: "voyage",
    model: "voyage-4",
    microusd: 500,
  })
  await work(dep, serviceSecret, "settle", leased, {
    id: id(960),
    tokens: 10,
    microusd: 200,
  })
  expect(
    (
      await sql(
        "SELECT source,run_id,agent_id,provider_cost_usd::text cost FROM agentonic.usage_events WHERE id=$1",
        [id(960)]
      )
    ).rows
  ).toEqual([
    { source: "run", run_id: leased.id, agent_id: a, cost: "0.00020000" },
  ])
})

it("restarts a stopped copy of a drop-in broker on the current broker", async () => {
  const { deploymentId: dep, hostId } = await servingOnBroker()
  const clock = { now: Date.now() }
  // Broker f's copies need a root-written drop-in; e's controller runs as its own user.
  await installBroker(hostId, brokers.e)
  const m = machine(brokers.e, clock, undefined, new Set([brokers.f]))
  m.configs.set(`${brokers.f}:${dep}`, {
    AGENTONIC_DEPLOYMENT_SECRET: serviceSecret,
  })
  await m.pass()
  expect(m.log).toEqual(["remove f", "start e"])
  expect(m.failures).toEqual([])
  const restored = copySecret(m, brokers.e, dep)
  expect(
    await copy("ready", dep, restored.AGENTONIC_DEPLOYMENT_SECRET!, {
      manifestHash: restored.AGENTONIC_MANIFEST_HASH,
      brokerHash: brokers.e,
    })
  ).toEqual({ ok: true })
  // The replaced copy's secret is refused.
  await expect(copy("heartbeat", dep, serviceSecret)).rejects.toThrow(
    "insufficient_privilege"
  )
})

it("leaves a running copy of a drop-in broker serving until it moves", async () => {
  const { deploymentId: dep, hostId } = await servingOnBroker()
  const clock = { now: Date.now() }
  await installBroker(hostId, brokers.e)
  const m = machine(brokers.e, clock, undefined, new Set([brokers.f]))
  m.configs.set(`${brokers.f}:${dep}`, {
    AGENTONIC_DEPLOYMENT_SECRET: serviceSecret,
  })
  m.processes.add(`${brokers.f}:${dep}`)
  await m.pass()
  // The usual move: a successor on e, while f keeps serving.
  expect(m.log).toEqual(["start e"])
  expect(m.processes.has(`${brokers.f}:${dep}`)).toBe(true)
  expect(m.failures).toEqual([])
})

it("shows staff each expiry as its own fact and keeps registrations from customers", async () => {
  const p = await modelReview()
  const model = { model: "gpt-5.4-mini", reasoning: "medium" }
  await actor()
  await flow("run", {
    preparationId: p.preparationId,
    revision: 1,
    models: [model],
    budgetUsd: 3,
    consent: true,
    requestId: id(990),
  })
  await finishFlow((await evalClaim())!, "passed", true, model.model)
  const host = (
    await sql(
      "INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,verified_at,heartbeat_at) VALUES('local','agentonic_deployer_local',repeat('f',64),clock_timestamp(),clock_timestamp()) RETURNING id"
    )
  ).rows[0] as { id: string }
  await sql(
    "INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256) VALUES($1,repeat('f',64))",
    [host.id]
  )
  await sql(
    "INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) VALUES($1,repeat('b',64))",
    [host.id]
  )
  await actor()
  const d = await lifecycleCall("deployment_command", "authorize", {
    submissionId: p.submissionId,
    environment: "local",
    budgetUsd: 0.25,
    consent: true,
    requestId: id(992),
  })
  expect(d.ok).toBe(true)
  await readyStaging({ ...p, deploymentId: String(d.id) })
  // The queue reads submitter emails through the bootstrap Auth bridge.
  await sql(
    "ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN email_confirmed_at timestamptz, ADD COLUMN deleted_at timestamptz"
  )
  await db.exec(
    readFileSync("scripts/sql/review-identity-boundary.sql", "utf8")
  )
  const registrations = async () => {
    await actor(staff, w, "agentonic_admin")
    const r = await db.query<{ result: unknown }>(
      "SELECT agentonic.runtime_registrations() result"
    )
    return runtimeRegistrations.parse(r.rows[0]!.result)
  }
  const queued = async () => {
    await actor(staff, w, "agentonic_admin")
    const r = await db.query<{ result: unknown }>(
      "SELECT agentonic.review_queue() result"
    )
    return reviewQueue
      .parse(r.rows[0]!.result)
      .find((row) => row.id === p.submissionId)!
  }
  // Host verification lasts seven days from the last verified installation.
  const fresh = await registrations()
  expect(fresh.hosts).toEqual([
    {
      environment: "local",
      verifiedAt: expect.any(String),
      expiresAt: expect.any(String),
      state: "valid",
    },
  ])
  expect(
    Date.parse(fresh.hosts[0]!.expiresAt) -
      Date.parse(fresh.hosts[0]!.verifiedAt)
  ).toBe(30 * 24 * 3600_000)
  expect(fresh.evaluators).toContainEqual(
    expect.objectContaining({ environment: "azure_staging", state: "valid" })
  )
  // The queue keeps the approval deadline and adds the customer's consent.
  const consent = (
    await sql(
      "SELECT authorized_until FROM agentonic.deployments WHERE id=$1",
      [d.id]
    )
  ).rows[0] as { authorized_until: Date }
  const row = await queued()
  expect(row).toMatchObject({
    status: "approved",
    approvalReason: "valid",
    deploymentStatus: "running",
    deploymentEnvironment: "local",
    deploymentAuthorized: true,
  })
  expect(
    Math.abs(
      Date.parse(row.consentExpiresAt!) - consent.authorized_until.getTime()
    )
  ).toBeLessThan(1)
  expect(row.approvalExpiresAt).not.toBe(row.consentExpiresAt)
  // Customers and the other application roles cannot read registrations.
  for (const role of ["agentonic_customer", "agentonic_worker"]) {
    await actor(owner, w, role)
    await db.exec("SAVEPOINT registrations")
    await expect(
      db.query("SELECT agentonic.runtime_registrations()")
    ).rejects.toMatchObject({ code: "42501" })
    await db.exec("ROLLBACK TO SAVEPOINT registrations")
  }
  // Registrations last 30 days (C19): a week-old one still authorizes.
  await sql(
    "UPDATE agentonic.runtime_hosts SET verified_at=clock_timestamp()-interval '8 days' WHERE id=$1",
    [host.id]
  )
  expect((await registrations()).hosts[0]).toMatchObject({ state: "valid" })
  expect(await queued()).toMatchObject({ deploymentAuthorized: true })
  // Within a day of expiry the host shows as expiring and still authorizes.
  await sql(
    "UPDATE agentonic.runtime_hosts SET verified_at=clock_timestamp()-interval '29 days 12 hours' WHERE id=$1",
    [host.id]
  )
  expect((await registrations()).hosts[0]).toMatchObject({ state: "expiring" })
  expect(await queued()).toMatchObject({ deploymentAuthorized: true })
  // Past thirty days the deployment loses authorization with it.
  await sql(
    "UPDATE agentonic.runtime_hosts SET verified_at=clock_timestamp()-interval '30 days 1 second' WHERE id=$1",
    [host.id]
  )
  expect((await registrations()).hosts[0]).toMatchObject({ state: "expired" })
  expect(await queued()).toMatchObject({ deploymentAuthorized: false })
  await sql(
    "UPDATE agentonic.runtime_hosts SET revoked_at=clock_timestamp() WHERE id=$1",
    [host.id]
  )
  expect((await registrations()).hosts[0]).toMatchObject({ state: "revoked" })
  // After a renewal the active registration is reported, not the retired one.
  await sql(
    "UPDATE agentonic.evaluation_workers SET retired_at=clock_timestamp() WHERE database_role='agentonic_eval_azure' AND revoked_at IS NULL AND retired_at IS NULL"
  )
  await sql(
    "INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,verified_at,verification) VALUES('agentonic_eval_azure','azure_staging',repeat('e',64),clock_timestamp()-interval '29 days 12 hours','{\"reviewProtocol\":3,\"isolation\":true,\"recovery\":true,\"artifactIntegrity\":true}')"
  )
  expect(
    (await registrations()).evaluators.filter(
      (e) => e.environment === "azure_staging"
    )
  ).toEqual([expect.objectContaining({ state: "expiring" })])
  expect(
    (
      await sql(
        "SELECT agentonic.registration_state(clock_timestamp(),NULL,clock_timestamp()) retired,agentonic.registration_state(clock_timestamp(),clock_timestamp(),clock_timestamp()) revoked"
      )
    ).rows[0]
  ).toEqual({ retired: "retired", revoked: "revoked" })
  // No function still checks a registration against the old 7-day window.
  const old = String.raw`verified_at\s*(>|<=|\+)[^;]{0,40}'7 days'`
  expect(
    (
      await sql(
        "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='agentonic' AND p.prosrc ~ $1",
        [old]
      )
    ).rows
  ).toEqual([])
})

it("starts a resting copy only when a turn waits for it", async () => {
  const { deploymentId: dep, leased, ask } = await servingOnBroker()
  const clock = { now: Date.now() }
  const m = machine(brokers.f, clock)
  const serving = `${brokers.f}:${dep}`
  m.configs.set(serving, { AGENTONIC_DEPLOYMENT_SECRET: serviceSecret })
  m.processes.add(serving)
  await m.pass()
  expect(m.log).toEqual([])
  // The idle copy rests and exits. Neither pass restarts it or counts a failure.
  expect(
    await work(dep, serviceSecret, "fail", leased, { code: "lease_lost" })
  ).toEqual({ ok: true })
  expect(await copy("rest", dep, serviceSecret)).toEqual({ ok: true })
  m.processes.delete(serving)
  await m.pass("watch")
  clock.now += 60_000
  await m.pass()
  expect(m.log).toEqual([])
  expect(m.failures).toEqual([])
  // A turn arrives: the next watch wakes the deployment and starts its copy.
  await ask(983)
  await m.pass("watch")
  expect(m.log).toEqual(["start f"])
  expect((await controller(brokers.f, "watch", null))!.deployments).toEqual([
    expect.objectContaining({ id: dep, resting: false, pending: true }),
  ])
  // A woken copy that never reports is handled like any copy that stopped.
  m.processes.delete(serving)
  await m.pass("watch")
  expect(m.failures).toEqual(["start:copy_exited"])
  expect(m.log).toEqual(["start f"])
})

it("moves a resting deployment to a new broker without starting its old copy", async () => {
  const { deploymentId: dep, hostId, leased } = await servingOnBroker()
  expect(
    await work(dep, serviceSecret, "fail", leased, { code: "lease_lost" })
  ).toEqual({ ok: true })
  expect(await copy("rest", dep, serviceSecret)).toEqual({ ok: true })
  await installBroker(hostId, brokers.e)
  const m = machine(brokers.e, { now: Date.now() })
  m.configs.set(`${brokers.f}:${dep}`, {
    AGENTONIC_DEPLOYMENT_SECRET: serviceSecret,
  })
  await m.pass()
  expect(m.log).toEqual(["start e"])
  const successor = copySecret(m, brokers.e, dep)
  expect(
    await copy("ready", dep, successor.AGENTONIC_DEPLOYMENT_SECRET!, {
      manifestHash: successor.AGENTONIC_MANIFEST_HASH,
      brokerHash: brokers.e,
    })
  ).toEqual({ ok: true })
  // The new copy serves awake; the old one, never started again, is removed.
  expect((await controllerPoll(brokers.e, "watch"))!.deployments).toEqual([
    expect.objectContaining({
      broker: brokers.e,
      drainingBroker: brokers.f,
      resting: false,
    }),
  ])
  await m.pass()
  expect(m.log).toEqual(["start e", "remove f"])
  expect(m.failures).toEqual([])
})

it("renews before expiry and recovers after it without replaying paid work or extending consent (A1)", async () => {
  const { deploymentId: dep, hostId, leased } = await servingOnBroker()
  const facts = async () =>
    (
      await sql(
        "SELECT d.authorized_until,d.committed_microusd::text spent,(SELECT count(*) FROM agentonic.retrieval_provider_operations)::int operations FROM agentonic.deployments d WHERE d.id=$1",
        [dep]
      )
    ).rows[0]
  const turn = async () =>
    (
      await sql(
        "SELECT status,error_code,started_at FROM agentonic.staging_turns WHERE id=$1",
        [leased.id]
      )
    ).rows[0] as { status: string; error_code: string | null; started_at: Date }
  const age = (interval: string) =>
    sql(
      `UPDATE agentonic.runtime_hosts SET verified_at=clock_timestamp()-interval '${interval}' WHERE id=$1`,
      [hostId]
    )
  // The renewal job's own guarded update: same host, not revoked.
  const renew = () =>
    sql(
      "UPDATE agentonic.runtime_hosts SET verified_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL",
      [hostId]
    )
  // What Admin and the customer's availability are built on.
  const shown = async () =>
    (
      await sql(
        "SELECT agentonic.deployment_authorized(d) authorized,agentonic.deployment_online(d) online FROM agentonic.deployments d WHERE d.id=$1",
        [dep]
      )
    ).rows[0]
  const before = await facts()
  const started = (await turn()).started_at

  // Renewal before expiry: nothing is interrupted, nothing restarts or resets.
  await age("29 days 23 hours")
  expect(await controller(brokers.f, "poll", null)).toBeTruthy()
  await renew()
  expect(await controller(brokers.f, "poll", null)).toBeTruthy()
  expect(await work(dep, serviceSecret, "claim")).toBeNull()
  expect(await turn()).toMatchObject({ status: "running", started_at: started })
  expect(await facts()).toEqual(before)

  // Expiry: a powered-on host is not an authorized runtime. The controller and
  // the agent's copy are refused, and staff no longer see it running.
  await age("30 days 1 second")
  await expect(controller(brokers.f, "poll", null)).rejects.toThrow()
  await expect(work(dep, serviceSecret, "claim")).rejects.toThrow()
  expect(await copy("heartbeat", dep, serviceSecret)).toEqual({
    ok: false,
    code: "unavailable",
  })
  // Its last heartbeat ages out within a minute; then it reads offline too.
  expect(await shown()).toMatchObject({ authorized: false })
  await sql(
    "UPDATE agentonic.deployments SET heartbeat_at=clock_timestamp()-interval '2 minutes' WHERE id=$1",
    [dep]
  )
  expect(await shown()).toEqual({ authorized: false, online: false })
  // The turn's lease runs out while the host is expired.
  await sql(
    "UPDATE agentonic.staging_turns SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [leased.id]
  )

  // Recovery: renewal restores service. The interrupted turn fails instead of
  // running again; consent, spend and provider calls are exactly as before.
  await renew()
  expect(await controller(brokers.f, "poll", null)).toBeTruthy()
  expect(await work(dep, serviceSecret, "claim")).toBeNull()
  expect(await turn()).toMatchObject({
    status: "failed",
    error_code: "lease_lost",
    started_at: started,
  })
  expect(await facts()).toEqual(before)
  expect(await copy("heartbeat", dep, serviceSecret)).toMatchObject({
    ok: true,
  })
  expect(await shown()).toEqual({ authorized: true, online: true })
})
