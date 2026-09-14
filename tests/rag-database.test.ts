import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { beforeEach, afterEach, expect, it } from "vitest"
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
async function submit() {
  await save()
  const frozen = await command("candidate.freeze", {
    agentId: a,
    revision: 1,
    codeReleaseId: code,
  })
  expect(frozen.ok).toBe(true)
  return command("submission.send", {
    candidateId: frozen.id,
    note: "Please review",
    consent: true,
  })
}
beforeEach(async () => {
  db = new PGlite({ extensions: { vector } })
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE agentonic_migrator;
 CREATE ROLE agentonic_admin NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_customer NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_worker NOSUPERUSER NOBYPASSRLS;
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
 INSERT INTO agentonic.code_releases(id,version,template_version_id,git_commit_sha,artifact_sha256,registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,artifact_key,artifact_size_bytes,published_by_staff_id) VALUES('${code}','0.1.0','${template}',repeat('a',40),repeat('b',64),repeat('c',64),'0.1','${id(60)}','synthetic','fixture',100,'${staff}');
 INSERT INTO agentonic.workspace_code_release_grants(workspace_id,code_release_id,granted_by_staff_id) VALUES('${w}','${code}','${staff}');
 INSERT INTO agentonic.agents(id,workspace_id,name,slug,owner_member_id,template_version_id,created_by_member_id) VALUES('${a}','${w}','Synthetic agent','synthetic','${member}','${template}','${member}');
 INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,owner_member_id) VALUES('${collection}','${w}','Knowledge','knowledge','${member}');`)
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
async function rag(operation: string, payload: Record<string, unknown> = {}) {
  const r = await db.query<{
    result: {
      id: string
      status: string
      matches: { id: string; text: string }[]
    }
  }>("SELECT agentonic.rag_command($1,$2::jsonb) result", [
    operation,
    JSON.stringify(payload),
  ])
  return r.rows[0]!.result
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
      { text, locator: { page: 1, start: 0, end: text.length }, embedding },
    ],
  })
}
it("indexes uploaded documents atomically and retrieves cited authorized text", async () => {
  const object = await upload()
  const job = await claim()
  expect(job.kind).toBe("ingest")
  await publish(job)
  await actor()
  const q = await rag("search", {
    query: "garantía",
    collectionIds: [collection],
  })
  const search = await claim()
  expect(search.id).toBe(q.id)
  await worker(search, "search", { embedding })
  await actor()
  const result = await rag("result", { id: q.id })
  expect(result.status).toBe("succeeded")
  expect(result.matches[0]!.text).toContain("tres años")
  const view = await command("list")
  expect(JSON.stringify(view)).toContain('"chunkCount":1')
  expect((await command("document.download", { objectId: object })).ok).toBe(
    true
  )
})
it("deletion blocks retrieval immediately and hard purge removes all document rows", async () => {
  const object = await upload()
  await publish(await claim())
  await actor()
  await submit()
  expect((await command("document.remove", { objectId: object })).ok).toBe(true)
  expect(
    (await sql("SELECT * FROM agentonic.document_chunks")).rows
  ).toHaveLength(0)
  await actor()
  expect((await command("document.download", { objectId: object })).ok).toBe(
    false
  )
  const purge = await claim()
  expect(purge.kind).toBe("purge")
  await worker(purge, "purged")
  for (const table of [
    "stored_objects",
    "documents",
    "document_versions",
    "document_chunks",
    "knowledge_sources",
    "ingestion_jobs",
    "background_jobs",
  ])
    expect((await sql(`SELECT * FROM agentonic.${table}`)).rows).toHaveLength(0)
  expect(
    (await sql("SELECT * FROM agentonic.agent_submissions")).rows
  ).toHaveLength(1)
})
it("a deleted document cannot be republished by an already running worker", async () => {
  const object = await upload()
  const stale = await claim()
  await actor()
  await command("document.remove", { objectId: object })
  await expect(publish(stale)).rejects.toThrow()
})
it("worker lease replacement fences stale results", async () => {
  await upload()
  const stale = await claim()
  await sql(
    "UPDATE agentonic.background_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",
    [stale.id]
  )
  const current = await claim()
  expect(current.token).not.toBe(stale.token)
  await expect(publish(stale)).rejects.toThrow()
})
it("other workspaces and staff cannot retrieve customer knowledge", async () => {
  await upload()
  await publish(await claim())
  await actor(other, otherW)
  await expect(
    rag("search", { query: "warranty", collectionIds: [collection] })
  ).rejects.toThrow()
})
it("enforces a global budget before calls and keeps ambiguous requests reserved", async () => {
  await upload()
  const job = await claim()
  const operation = id(900)
  expect(
    (
      await worker(job, "reserve", {
        id: operation,
        provider: "voyage",
        model: "voyage-4",
        microusd: 100,
      })
    ).ok
  ).toBe(false)
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=150 WHERE provider='voyage'"
  )
  expect(
    (
      await worker(job, "reserve", {
        id: operation,
        provider: "voyage",
        model: "voyage-4",
        microusd: 100,
      })
    ).ok
  ).toBe(true)
  expect(
    (
      await worker(job, "reserve", {
        id: id(901),
        provider: "voyage",
        model: "voyage-4",
        microusd: 100,
      })
    ).ok
  ).toBe(false)
  await worker(job, "settle", { id: operation, tokens: 100, microusd: 6 })
  expect(
    (
      await sql(
        "SELECT committed_microusd FROM agentonic.retrieval_provider_budgets WHERE provider='voyage'"
      )
    ).rows[0]
  ).toEqual({ committed_microusd: 6 })
})
it("ordinary app roles cannot claim jobs or call legacy authoring bypass", async () => {
  await expect(db.query("SELECT agentonic.rag_claim(false)")).rejects.toThrow()
})
it("rechecks evidence before answer publication and erases completed answers on deletion", async () => {
  const object = await upload()
  await publish(await claim())
  await actor()
  const q = await rag("search", {
    query: "garantía",
    collectionIds: [collection],
    generateAnswer: true,
  })
  const job = await claim()
  await worker(job, "search", { embedding })
  const context = (await worker(job, "context")) as {
    passages: { id: string }[]
  }
  expect(context.passages).toHaveLength(1)
  await worker(job, "answer", {
    text: "La garantía dura tres años.",
    citations: [context.passages[0]!.id],
    insufficientEvidence: false,
    model: "gpt-4.1-mini-2025-04-14",
  })
  await actor()
  expect(JSON.stringify(await rag("result", { id: q.id }))).toContain(
    "La garantía dura tres años."
  )
  await command("document.remove", { objectId: object })
  expect(JSON.stringify(await rag("result", { id: q.id }))).not.toContain(
    "La garantía dura tres años."
  )
  const rows = await sql(
    "SELECT result,payload FROM agentonic.background_jobs WHERE id=$1",
    [q.id]
  )
  expect(rows.rows[0]).toEqual({ result: {}, payload: {} })
})
it("blocks a generated answer whose document was deleted while the model was running", async () => {
  const object = await upload()
  await publish(await claim())
  await actor()
  await rag("search", {
    query: "garantía",
    collectionIds: [collection],
    generateAnswer: true,
  })
  const job = await claim()
  await worker(job, "search", { embedding })
  const context = (await worker(job, "context")) as {
    passages: { id: string }[]
  }
  await actor()
  await command("document.remove", { objectId: object })
  await expect(
    worker(job, "answer", {
      text: "Three years",
      citations: [context.passages[0]!.id],
      insufficientEvidence: false,
      model: "gpt-4.1-mini-2025-04-14",
    })
  ).rejects.toThrow()
})
it("rejects invented citations even from an authorized worker", async () => {
  await upload()
  await publish(await claim())
  await actor()
  await rag("search", {
    query: "garantía",
    collectionIds: [collection],
    generateAnswer: true,
  })
  const job = await claim()
  await worker(job, "search", { embedding })
  await expect(
    worker(job, "answer", {
      text: "Three years",
      citations: [id(999)],
      insufficientEvidence: false,
      model: "gpt-4.1-mini-2025-04-14",
    })
  ).rejects.toThrow()
})
it("revoking collection access invalidates queued retrieval", async () => {
  await upload()
  await publish(await claim())
  await actor()
  const q = await rag("search", {
    query: "garantía",
    collectionIds: [collection],
  })
  await sql(
    "UPDATE agentonic.workspace_members SET status='suspended' WHERE id=$1",
    [member]
  )
  expect(await claim()).toBeNull()
  expect(
    (
      await sql("SELECT status FROM agentonic.background_jobs WHERE id=$1", [
        q.id,
      ])
    ).rows[0]
  ).toEqual({ status: "cancelled" })
})
it("private ingestion internals are unavailable to customer direct reads and legacy bypass", async () => {
  await expect(
    db.query("SELECT agentonic.authoring_command_v6($1,$2::jsonb,$3::uuid)", [
      "list",
      "{}",
      id(999),
    ])
  ).rejects.toThrow()
})
it("staff cannot use customer retrieval merely by selecting a workspace", async () => {
  await actor(staff, w, "agentonic_admin")
  await expect(
    rag("search", { query: "garantía", collectionIds: [collection] })
  ).rejects.toThrow()
})

it("ranks only the selected collection even when another document matches the query", async () => {
  await upload()
  await publish(await claim(), "The selected warranty lasts three years.")
  const second = id(31)
  await sql(
    "INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,owner_member_id) VALUES($1,$2,'Other knowledge','other-knowledge',$3)",
    [second, w, member]
  )
  await upload(second)
  await publish(await claim(), "The other warranty lasts ninety years.")
  await actor()
  const q = await rag("search", {
    query: "warranty",
    collectionIds: [collection],
  })
  await worker(await claim(), "search", { embedding })
  await actor()
  const result = await rag("result", { id: q.id })
  expect(result.matches).toHaveLength(1)
  expect(result.matches[0]!.text).toContain("three years")
  expect(JSON.stringify(result)).not.toContain("ninety")
})

it("removes empty collections without typing a name and retains only a tombstone", async () => {
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(true)
  expect(JSON.stringify(await command("list"))).not.toContain(collection)
  expect(
    (
      await command("upload.reserve", {
        collectionId: collection,
        title: "fixture.md",
        sha256: "a".repeat(64),
        size: 120,
        contentType: "text/markdown",
      })
    ).ok
  ).toBe(false)
  const tombstone = (
    await sql(
      "SELECT name,slug,description,archived_at FROM agentonic.knowledge_collections WHERE id=$1",
      [collection]
    )
  ).rows[0]!
  expect(tombstone).toMatchObject({
    name: "Colección eliminada",
    description: null,
    archived_at: expect.any(Date),
  })
  expect(
    (await sql("SELECT * FROM agentonic.background_jobs")).rows
  ).toHaveLength(0)
})

it("requires the current name server-side for pending or completed documents, including stale empty views", async () => {
  const pending = await command("upload.reserve", {
    collectionId: collection,
    title: "fixture.md",
    sha256: "a".repeat(64),
    size: 120,
    contentType: "text/markdown",
  })
  expect(pending.ok).toBe(true)
  for (const confirmationName of ["", "knowledge", "Knowledge "]) {
    expect(
      await command("collection.remove", {
        collectionId: collection,
        confirmationName,
      })
    ).toEqual({ ok: false, code: "confirmation_required" })
  }
  expect(
    (
      await sql(
        "SELECT * FROM agentonic.stored_objects WHERE deleted_at IS NULL"
      )
    ).rows
  ).toHaveLength(1)
  await actor()
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "Knowledge",
      })
    ).ok
  ).toBe(true)
  const purge = await claim()
  expect(purge.kind).toBe("purge")
  await worker(purge, "purged")
  expect(
    (await sql("SELECT * FROM agentonic.stored_objects")).rows
  ).toHaveLength(0)
})

it("deletes every collection document, cancels stale ingestion, preserves other collections and usage", async () => {
  const first = await upload()
  await publish(await claim())
  await actor()
  const query = await rag("search", {
    query: "garantía",
    collectionIds: [collection],
  })
  await worker(await claim(), "search", { embedding })
  const second = await upload()
  const stale = await claim()
  await sql(
    "INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,owner_member_id) VALUES($1,$2,'Other knowledge','other-knowledge',$3)",
    [id(31), w, member]
  )
  const retained = await upload(id(31))
  await publish(await claim())
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=10000000,committed_microusd=123 WHERE provider='voyage'"
  )
  await actor()
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "Knowledge",
      })
    ).ok
  ).toBe(true)
  const view = JSON.stringify(await command("list"))
  expect(view).not.toContain(first)
  expect(view).not.toContain(second)
  expect(view).toContain(retained)
  expect(view).toContain('"pendingDeletions":2')
  expect((await rag("result", { id: query.id })).status).not.toBe("succeeded")
  expect((await command("document.download", { objectId: first })).ok).toBe(
    false
  )
  await db.exec("SAVEPOINT stale_publish")
  await expect(publish(stale)).rejects.toThrow()
  await db.exec(
    "ROLLBACK TO SAVEPOINT stale_publish; RELEASE SAVEPOINT stale_publish"
  )
  for (let i = 0; i < 2; i++) {
    const purge = await claim()
    expect(purge.kind).toBe("purge")
    await worker(purge, "purged")
  }
  expect((await sql("SELECT id FROM agentonic.stored_objects")).rows).toEqual([
    { id: retained },
  ])
  expect(
    (await sql("SELECT * FROM agentonic.document_chunks")).rows
  ).toHaveLength(1)
  expect(
    (
      await sql(
        "SELECT committed_microusd::int amount FROM agentonic.retrieval_provider_budgets WHERE provider='voyage'"
      )
    ).rows
  ).toEqual([{ amount: 123 }])
})

it("denies cross-workspace, read-only, revoked and staff collection deletion, but allows a current curator", async () => {
  await actor(other, otherW)
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(false)
  await sql(
    "INSERT INTO agentonic.workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
    [id(103), w, other]
  )
  await sql(
    "INSERT INTO agentonic.collection_member_grants(workspace_id,collection_id,member_id,permission,granted_by_member_id) VALUES($1,$2,$3,'read',$4)",
    [w, collection, id(103), member]
  )
  await actor(other, w)
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(false)
  await sql(
    "UPDATE agentonic.collection_member_grants SET permission='curate',revoked_at=now() WHERE collection_id=$1",
    [collection]
  )
  await actor(other, w)
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(false)
  await actor(staff, w, "agentonic_admin")
  await expect(
    command("collection.remove", {
      collectionId: collection,
      confirmationName: "",
    })
  ).rejects.toThrow()
  await sql(
    "UPDATE agentonic.collection_member_grants SET revoked_at=NULL WHERE collection_id=$1",
    [collection]
  )
  await actor(other, w)
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(true)
})

it("deduplicates collection purge jobs for documents already removed individually", async () => {
  const object = await upload()
  await command("document.remove", { objectId: object })
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(true)
  expect(
    (await sql("SELECT * FROM agentonic.background_jobs WHERE kind='purge'"))
      .rows
  ).toHaveLength(1)
  const purge = await claim()
  await worker(purge, "purged")
  expect(
    (await sql("SELECT * FROM agentonic.stored_objects")).rows
  ).toHaveLength(0)
})
