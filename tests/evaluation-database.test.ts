import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { beforeEach, afterEach, expect, it, vi } from "vitest"
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
import { vector } from "@electric-sql/pglite-pgvector"
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
  db = new PGlite({ extensions: { vector } })
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE agentonic_migrator;
 CREATE ROLE agentonic_admin NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_customer NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_worker NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_deployer_local NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_deployer_azure NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_runtime_local NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_runtime_azure NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_eval_local NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_eval_azure NOSUPERUSER NOBYPASSRLS;
 CREATE SCHEMA agentonic_bootstrap;
 CREATE FUNCTION agentonic_bootstrap.link_auth_users() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $f$ ALTER TABLE agentonic.users ADD CONSTRAINT users_auth_user_fk FOREIGN KEY(auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT; $f$;
 CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,public boolean,file_size_limit bigint); INSERT INTO storage.buckets VALUES('agentonic-documents',false,10485760);
 CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text,metadata jsonb); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; GRANT USAGE ON SCHEMA storage TO authenticated; GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;`)
  await db.exec(readFileSync("scripts/sql/storage-boundary.sql", "utf8"))
  for (const migration of [
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
  ])
    await db.exec(
      readFileSync(
        `packages/database/prisma/migrations/${migration}/migration.sql`,
        "utf8"
      )
    )
  await db.exec(`INSERT INTO auth.users VALUES('${owner}'),('${other}'),('${staff}');
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
 INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,owner_member_id) VALUES('${collection}','${w}','Knowledge','knowledge','${member}');`)
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
    "INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,runtime_sha256,verified_at,verification) VALUES('agentonic_eval_azure','azure_staging',repeat('d',64),repeat('b',64),now(),'{\"reviewProtocol\":3,\"isolation\":true,\"recovery\":true,\"artifactIntegrity\":true}')"
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
      { model: "gpt-4.1-mini-2025-04-14", reasoning: null },
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
  await finishFlow(claimedModel!)
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
    models: [{ model: "gpt-4.1-mini-2025-04-14", reasoning: null }],
    budgetUsd: 3,
    consent: true,
    requestId: id(992),
  }
  await actor()
  await flow("run", payload)
  const job = (await evalClaim())!
  await finishFlow(job)
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
    "INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,runtime_sha256,verified_at,heartbeat_at) VALUES('local','agentonic_deployer_local',repeat('f',64),repeat('b',64),clock_timestamp(),clock_timestamp())"
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
