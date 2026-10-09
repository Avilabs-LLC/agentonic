import { readFileSync } from "node:fs"
import type { PGlite } from "@electric-sql/pglite"
import { beforeEach, afterEach, expect, it } from "vitest"
import { preparedDatabase } from "../scripts/prepared-database"
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
const requested = { version: 1, collectionIds: [collection], tools: [] }
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
 CREATE ROLE agentonic_admin NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_customer NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_worker NOSUPERUSER NOBYPASSRLS;
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
 INSERT INTO agentonic.code_releases(id,version,template_version_id,git_commit_sha,artifact_sha256,registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,artifact_key,artifact_size_bytes,published_by_staff_id,execution_manifest) VALUES('${code}','0.1.0','${template}',repeat('a',40),repeat('b',64),repeat('c',64),'0.1','${id(60)}','synthetic','fixture',100,'${staff}','{"previewContract":"1","model":"gpt-4.1-mini-2025-04-14"}');
 INSERT INTO agentonic.workspace_code_release_grants(workspace_id,code_release_id,granted_by_staff_id) VALUES('${w}','${code}','${staff}');
 INSERT INTO agentonic.agents(id,workspace_id,name,slug,owner_member_id,template_version_id,created_by_member_id) VALUES('${a}','${w}','Synthetic agent','synthetic','${member}','${template}','${member}');
 INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,owner_member_id) VALUES('${collection}','${w}','Knowledge','knowledge','${member}');`,
  ])
})
beforeEach(async () => {
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
async function preview(
  operation: string,
  payload: Record<string, unknown> = {}
) {
  await db.exec("SAVEPOINT preview_test")
  try {
    const r = await db.query<{
      result: {
        ok: boolean
        id?: string
        code?: string
        turns?: { query: string; answer: { text: string } }[]
      }
    }>("SELECT agentonic.preview_command($1,$2::jsonb) result", [
      operation,
      JSON.stringify({ agentId: a, ...payload }),
    ])
    await db.exec("RELEASE SAVEPOINT preview_test")
    return r.rows[0]!.result
  } catch (e) {
    await db.exec(
      "ROLLBACK TO SAVEPOINT preview_test; RELEASE SAVEPOINT preview_test"
    )
    throw e
  }
}
async function start() {
  await actor()
  await save()
  const c = await command("candidate.freeze", {
    agentId: a,
    revision: 1,
    codeReleaseId: code,
  })
  const p = await preview("start", { candidateId: c.id })
  expect(p.ok).toBe(true)
  return { id: String(p.id), candidateId: c.id }
}
it("pins the candidate and history; serializes and deduplicates private turns", async () => {
  await upload()
  await publish(await claim())
  const p = await start()
  const first = await preview("turn", {
    previewId: p.id,
    query: "garantía",
    requestKey: id(200),
  })
  expect(
    (
      await preview("turn", {
        previewId: p.id,
        query: "garantía",
        requestKey: id(200),
      })
    ).id
  ).toBe(first.id)
  expect(
    (
      await preview("turn", {
        previewId: p.id,
        query: "otra",
        requestKey: id(201),
      })
    ).code
  ).toBe("busy")
  const job = await claim()
  await worker(job, "search", { embedding })
  const context = await worker(job, "context")
  expect(context.configurationJson).toContain(content.systemPrompt)
  expect(context.history).toEqual([])
  const passages = context.passages as { id: string }[]
  expect(passages).toHaveLength(1)
  await worker(job, "answer", {
    text: "Tres años.",
    citations: [passages[0]!.id],
    insufficientEvidence: false,
    model: "gpt-4.1-mini-2025-04-14",
  })
  await actor()
  const state = await preview("state", { previewId: p.id })
  expect(state.turns![0]!.query).toBe("garantía")
  expect(state.turns![0]!.answer.text).toBe("Tres años.")
  await command("draft.save", {
    agentId: a,
    revision: 1,
    content: { ...content, systemPrompt: "A changed draft" },
    requestedAccess: requested,
  })
  await preview("turn", {
    previewId: p.id,
    query: "¿Y después?",
    requestKey: id(201),
  })
  const next = await claim()

  expect((await worker(next, "read")).retrievalQuery).toBe(
    "garantía\n¿Y después?"
  )
  await worker(next, "search", { embedding })
  const nextContext = await worker(next, "context")
  expect(nextContext.configurationJson).toContain(content.systemPrompt)
  expect(nextContext.configurationJson).not.toContain("A changed draft")
  expect(nextContext.history).toEqual([
    { query: "garantía", answer: "Tres años." },
  ])
  await actor(other, otherW)
  expect((await preview("state", { previewId: p.id })).code).toBe("unavailable")
  await actor(staff, w, "agentonic_admin")
  await expect(preview("state", { previewId: p.id })).rejects.toThrow()
})
it("does not retrieve sources added after freezing and invalidates deleted evidence", async () => {
  await upload()
  await publish(await claim(), "Original evidence")
  const p = await start()

  const second = await upload()
  const laterJob = await claim()
  await publish(laterJob, "Later source")
  await actor()
  await preview("turn", {
    previewId: p.id,
    query: "evidence",
    requestKey: id(200),
  })
  const job = await claim()
  await worker(job, "search", { embedding })

  const ctx = await worker(job, "context")
  expect(ctx.passages).toEqual([
    expect.objectContaining({ text: "Original evidence" }),
  ])
  await actor()
  await command("document.remove", { objectId: second })
  expect((await preview("state", { previewId: p.id })).code).toBe("unavailable")
  const rows = await sql(
    "SELECT payload,result FROM agentonic.background_jobs WHERE preview_id=$1",
    [p.id]
  )
  expect(rows.rows).toEqual([{ payload: {}, result: {} }])
  await expect(worker(job, "context")).rejects.toThrow()
})
it("reserves against the existing total and preview ceiling without resetting balances", async () => {
  const p = await start()
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=25000000,committed_microusd=1000000 WHERE provider='openai'"
  )
  await actor()
  await preview("turn", {
    previewId: p.id,
    query: "hello",
    requestKey: id(200),
  })
  const job = await claim()
  expect(
    await worker(job, "reserve", {
      id: id(301),
      provider: "openai",
      model: "gpt-4.1-mini-2025-04-14",
      microusd: 200000,
    })
  ).toMatchObject({ ok: true })
  expect(
    await worker(job, "reserve", {
      id: id(302),
      provider: "openai",
      model: "gpt-4.1-mini-2025-04-14",
      microusd: 60000,
    })
  ).toMatchObject({ ok: false })
  await worker(job, "settle", {
    id: id(301),
    tokens: 100,
    outputTokens: 20,
    microusd: 80,
  })
  const totals = await sql(
    "SELECT committed_microusd FROM agentonic.retrieval_provider_budgets WHERE provider='openai'"
  )
  expect(
    Number(
      (totals.rows[0] as { committed_microusd: string }).committed_microusd
    )
  ).toBe(1000080)
})
it("denies revoked authors, enforces expiry and never automatically retries paid preview turns", async () => {
  const p = await start()
  await preview("turn", {
    previewId: p.id,
    query: "hello",
    requestKey: id(200),
  })
  const job = await claim()
  await worker(job, "fail", { code: "provider_unavailable" })
  expect(await claim()).toBeNull()
  await sql("UPDATE agentonic.agents SET archived_at=now() WHERE id=$1", [a])
  await actor()
  expect((await preview("state", { previewId: p.id })).code).toBe("unavailable")
})
it("keeps transcripts private from another maintainer in the same workspace", async () => {
  const p = await start()
  await sql(
    `INSERT INTO agentonic.workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')`,
    [id(103), w, other]
  )
  await sql(
    `INSERT INTO agentonic.agent_member_grants(workspace_id,agent_id,member_id,role,granted_by_member_id) VALUES($1,$2,$3,'maintainer',$4)`,
    [w, a, id(103), member]
  )
  await actor(other, w)
  expect((await preview("state", { previewId: p.id })).code).toBe("unavailable")
  expect((await preview("cancel", { previewId: p.id })).code).toBe(
    "unavailable"
  )
})
it("revokes collection access before provider work and scrubs expired conversations", async () => {
  const p = await start()
  await preview("turn", {
    previewId: p.id,
    query: "private question",
    requestKey: id(200),
  })
  const job = await claim()
  await actor()
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(true)
  expect((await preview("state", { previewId: p.id })).code).toBe("unavailable")
  await expect(worker(job, "context")).rejects.toThrow()
})
it("enforces ten turns and expires the whole preview instead of extending it", async () => {
  const p = await start()
  for (let i = 0; i < 10; i++) {
    await actor()
    expect(
      (
        await preview("turn", {
          previewId: p.id,
          query: "test",
          requestKey: id(200 + i),
        })
      ).ok
    ).toBe(true)
    await worker(await claim(), "fail", { code: "provider_unavailable" })
  }
  await actor()
  expect(
    (
      await preview("turn", {
        previewId: p.id,
        query: "test",
        requestKey: id(300),
      })
    ).code
  ).toBe("turn_limit")
  await sql(
    "UPDATE agentonic.agent_previews SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE id=$1",
    [p.id]
  )
  await actor()
  expect((await preview("state", { previewId: p.id })).code).toBe("unavailable")
  expect(await claim()).toBeNull()
  const result = await sql(
    "SELECT count(*)::int count FROM agentonic.background_jobs WHERE preview_id=$1",
    [p.id]
  )
  expect(result.rows[0]).toEqual({ count: 0 })
})

async function discovered(target = a) {
  return (
    await db.query<{ id: string; candidate_id: string; expires_at: string }>(
      "SELECT * FROM agentonic.active_agent_previews($1)",
      [target]
    )
  ).rows
}
it("discovers only active authorized tests without starting sessions or changing usage", async () => {
  await actor()
  expect(await discovered()).toEqual([])
  const p = await start()
  const before = await sql(
    "SELECT id,expires_at,committed_microusd FROM agentonic.agent_previews"
  )
  await actor()
  expect(await discovered()).toMatchObject([
    { id: p.id, candidate_id: p.candidateId },
  ])
  expect(await discovered(id(999))).toEqual([])
  const after = await sql(
    "SELECT id,expires_at,committed_microusd FROM agentonic.agent_previews"
  )
  expect(after.rows).toEqual(before.rows)
  await actor()
  await preview("cancel", { previewId: p.id })
  expect(await discovered()).toEqual([])
})
it("does not disclose another maintainer's test or another workspace's tests", async () => {
  await start()
  await sql(
    "INSERT INTO agentonic.workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
    [id(103), w, other]
  )
  await sql(
    "INSERT INTO agentonic.agent_member_grants(workspace_id,agent_id,member_id,role,granted_by_member_id) VALUES($1,$2,$3,'maintainer',$4)",
    [w, a, id(103), member]
  )
  await actor(other, w)
  expect(await discovered()).toEqual([])
  await actor(other, otherW)
  expect(await discovered()).toEqual([])
})
it("hides expired tests even before worker cleanup", async () => {
  const p = await start()
  await sql(
    "UPDATE agentonic.agent_previews SET created_at=now()-interval '11 minutes',expires_at=now()-interval '1 minute' WHERE id=$1",
    [p.id]
  )
  await actor()
  expect(await discovered()).toEqual([])
})
it("hides tests after access revocation", async () => {
  await start()
  await sql("UPDATE agentonic.agents SET archived_at=now() WHERE id=$1", [a])
  await actor()
  expect(await discovered()).toEqual([])
})
