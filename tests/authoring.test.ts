import { readFileSync } from "node:fs"
import { reviewQueue } from "../packages/contracts/src/authoring"
import { PGlite } from "@electric-sql/pglite"
import { beforeAll, afterAll, beforeEach, afterEach, expect, it } from "vitest"
const db = new PGlite()
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
beforeAll(async () => {
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
    "202609150012_review_queue",
    "202609150016_candidate_creation_clock",
  ])
    await db.exec(
      readFileSync(
        `packages/database/prisma/migrations/${migration}/migration.sql`,
        "utf8"
      )
    )
  await db.exec(
    "ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN email_confirmed_at timestamptz, ADD COLUMN deleted_at timestamptz"
  )
  await db.exec(
    readFileSync("scripts/sql/review-identity-boundary.sql", "utf8")
  )
  await db.exec(`INSERT INTO auth.users(id) VALUES('${owner}'),('${other}'),('${staff}');
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
afterAll(() => db.close())
beforeEach(async () => {
  await db.exec("RESET ROLE;BEGIN")
  await actor()
})
afterEach(() => db.exec("ROLLBACK;RESET ROLE"))
it("persists drafts with optimistic revision conflicts", async () => {
  expect((await save()).ok).toBe(true)
  expect((await save()).code).toBe("conflict")
  expect((await command("detail", { agentId: a })).data.draft.content).toEqual(
    content
  )
})
it("freezes exact content and later draft edits do not change submission", async () => {
  const s = await submit()
  expect(s.ok).toBe(true)
  await command("draft.save", {
    agentId: a,
    revision: 1,
    content: { ...content, systemPrompt: "Changed" },
    requestedAccess: requested,
  })
  await actor(staff, w, "agentonic_admin")
  const review = await command("review.open", { submissionId: s.id })
  expect(review.ok).toBe(true)
  expect(review.data.content).toEqual(content)
})
it("denies another workspace and no context", async () => {
  await actor(other, otherW)
  expect((await command("detail", { agentId: a })).ok).toBe(false)
  expect((await command("list")).data.agents).toEqual([])
  expect((await command("list")).data.templates).toEqual([])
})
it("requires explicit collection access even when editing an agent", async () => {
  expect(
    (
      await command("draft.save", {
        agentId: a,
        revision: 0,
        content,
        requestedAccess: { ...requested, collectionIds: [id(998)] },
      })
    ).ok
  ).toBe(false)
})
it("rejects executable fields, duplicate skills and arbitrary access", async () => {
  for (const c of [
    { ...content, shell: "whoami" },
    { ...content, skills: [content.skills[0], content.skills[0]] },
  ])
    expect(
      (
        await command("draft.save", {
          agentId: a,
          revision: 0,
          content: c,
          requestedAccess: requested,
        })
      ).ok
    ).toBe(false)
  expect(
    (
      await command("draft.save", {
        agentId: a,
        revision: 0,
        content,
        requestedAccess: { ...requested, tools: ["shell"] },
      })
    ).ok
  ).toBe(false)
})
it("rechecks code grants before freezing", async () => {
  await save()
  await sql(
    "UPDATE agentonic.workspace_code_release_grants SET revoked_at=now()"
  )
  await actor()
  expect(
    (
      await command("candidate.freeze", {
        agentId: a,
        revision: 1,
        codeReleaseId: code,
      })
    ).ok
  ).toBe(false)
})
it("requires consent and denies customer review access", async () => {
  await save()
  const c = await command("candidate.freeze", {
    agentId: a,
    revision: 1,
    codeReleaseId: code,
  })
  expect(
    (
      await command("submission.send", {
        candidateId: c.id,
        note: "",
        consent: false,
      })
    ).ok
  ).toBe(false)
  expect((await command("review.queue")).ok).toBe(false)
})
it("staff private reads require exact grant and are audited", async () => {
  const s = await submit()
  await actor(staff, w, "agentonic_admin")
  expect(
    (await db.query("SELECT * FROM agentonic.configuration_releases")).rows
  ).toHaveLength(0)
  const r = await command("review.open", { submissionId: s.id })
  expect(r.ok).toBe(true)
  expect(r.data.grantId).toBeTruthy()
  const audit = await sql(
    "SELECT * FROM agentonic.audit_events WHERE action='review.open'"
  )
  expect(audit.rows).toHaveLength(1)
  expect(JSON.stringify(audit.rows)).not.toContain(content.systemPrompt)
})
it("denies support from customer app role even for a real staff user", async () => {
  const s = await submit()
  await actor(staff, w)
  await expect(
    command("review.open", { submissionId: s.id })
  ).rejects.toBeDefined()
})
it("records feedback and closes review after requesting changes", async () => {
  const s = await submit()
  await actor(staff, w, "agentonic_admin")
  const r = await command("review.open", { submissionId: s.id })
  expect(
    (
      await command("review.decide", {
        submissionId: s.id,
        grantId: r.data.grantId,
        decision: "changes_requested",
        feedback: "Clarify scope",
      })
    ).ok
  ).toBe(true)
  expect((await command("review.open", { submissionId: s.id })).ok).toBe(false)
  await actor()
  expect(
    (await command("detail", { agentId: a })).data.submissions[0]!.decisions[0]!
      .feedback
  ).toBe("Clarify scope")
})
it("does not permit approval or deployment before execution controls", async () => {
  const s = await submit()
  await actor(staff, w, "agentonic_admin")
  const r = await command("review.open", { submissionId: s.id })
  expect(
    (
      await command("review.decide", {
        submissionId: s.id,
        grantId: r.data.grantId,
        decision: "approved",
        feedback: "ok",
      })
    ).ok
  ).toBe(false)
  expect((await command("deploy", {})).ok).toBe(false)
})
it("withdrawal immediately revokes staff review", async () => {
  const s = await submit()
  await actor(staff, w, "agentonic_admin")
  const r = await command("review.open", { submissionId: s.id })
  await actor()
  expect(
    (await command("submission.withdraw", { submissionId: s.id })).ok
  ).toBe(true)
  await actor(staff, w, "agentonic_admin")
  expect(
    (
      await command("review.decide", {
        submissionId: s.id,
        grantId: r.data.grantId,
        decision: "in_review",
        feedback: "review",
      })
    ).ok
  ).toBe(false)
})
it("blocks replayed submission and immutable content updates", async () => {
  await submit()
  const c = (await command("detail", { agentId: a })).data.candidates[0]!
  await expect(
    command("submission.send", {
      candidateId: c.id,
      consent: true,
      note: "again",
    })
  ).rejects.toBeDefined()
  await expect(
    sql(
      "UPDATE agentonic.configuration_releases SET content='{}' WHERE workspace_id=$1",
      [w]
    )
  ).rejects.toBeDefined()
})
it("reserves uploads but cannot mark missing blobs complete", async () => {
  const r = await command("upload.reserve", {
    collectionId: collection,
    title: "test.txt",
    sha256: "a".repeat(64),
    size: 4,
    contentType: "text/plain",
  })
  expect(r.ok).toBe(true)
  expect((await command("upload.complete", { objectId: r.id })).ok).toBe(false)
  expect((await command("document.download", { objectId: r.id })).ok).toBe(
    false
  )
})
it("requires live membership and resource grants through Storage RLS", async () => {
  const r = await command("upload.reserve", {
    collectionId: collection,
    title: "test.txt",
    sha256: "a".repeat(64),
    size: 4,
    contentType: "text/plain",
  })
  await db.exec("RESET ROLE;SET LOCAL ROLE authenticated")
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: owner }),
  ])
  await db.query(
    "INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('agentonic-documents',$1,'{\"size\":4}')",
    [r.data.objectKey]
  )
  await actor()
  expect((await command("upload.complete", { objectId: r.id })).ok).toBe(true)
  expect((await command("document.download", { objectId: r.id })).ok).toBe(true)
  await db.exec("RESET ROLE;SET LOCAL ROLE authenticated")
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: other }),
  ])
  expect((await db.query("SELECT * FROM storage.objects")).rows).toHaveLength(0)
  await actor()
  expect((await command("document.remove", { objectId: r.id })).ok).toBe(true)
  await db.exec("RESET ROLE;SET LOCAL ROLE authenticated")
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: owner }),
  ])
  expect((await db.query("SELECT * FROM storage.objects")).rows).toHaveLength(0)
})
it("cannot enable unimplemented source or document readiness", async () => {
  const r = await command("upload.reserve", {
    collectionId: collection,
    title: "test.txt",
    sha256: "a".repeat(64),
    size: 4,
    contentType: "text/plain",
  })
  expect(r.ok).toBe(true)
  await expect(
    sql("UPDATE agentonic.document_versions SET status='ready'")
  ).rejects.toBeDefined()
})
it("rejects an expired grant and cannot substitute a different grant", async () => {
  const s = await submit()
  await actor(staff, w, "agentonic_admin")
  const r = await command("review.open", { submissionId: s.id })
  expect(
    (await command("review.read", { submissionId: s.id, grantId: id(998) })).ok
  ).toBe(false)
  // Arrange historical timestamps as the fixture owner; application writes remain immutable.
  await sql("ALTER TABLE agentonic.support_access_grants DISABLE TRIGGER USER")
  await sql(
    "UPDATE agentonic.support_access_grants SET created_at=now()-interval '2 days', expires_at=now()-interval '1 day' WHERE id=$1",
    [r.data.grantId]
  )
  await sql("ALTER TABLE agentonic.support_access_grants ENABLE TRIGGER USER")
  await actor(staff, w, "agentonic_admin")
  expect(
    (
      await command("review.read", {
        submissionId: s.id,
        grantId: r.data.grantId,
      })
    ).ok
  ).toBe(false)
})

it("offboarding permanently revokes upload authority even after reactivation", async () => {
  const r = await command("upload.reserve", {
    collectionId: collection,
    title: "test.txt",
    sha256: "a".repeat(64),
    size: 4,
    contentType: "text/plain",
  })
  await sql(
    "UPDATE agentonic.workspace_members SET status='suspended' WHERE id=$1",
    [member]
  )
  await sql(
    "UPDATE agentonic.workspace_members SET status='active' WHERE id=$1",
    [member]
  )
  await db.exec("RESET ROLE;SET LOCAL ROLE authenticated")
  await db.query("SELECT set_config('request.jwt.claims',$1,true)", [
    JSON.stringify({ sub: owner }),
  ])
  const allowed = await db.query<{ allowed: boolean }>(
    "SELECT agentonic_storage.allowed($1,'upload') allowed",
    [r.data.objectKey]
  )
  expect(allowed.rows[0]!.allowed).toBe(false)
})
it("revoked collection access closes a previously opened review", async () => {
  const s = await submit()
  await actor(staff, w, "agentonic_admin")
  const r = await command("review.open", { submissionId: s.id })
  await sql(
    "UPDATE agentonic.knowledge_collections SET archived_at=now() WHERE id=$1",
    [collection]
  )
  await actor(staff, w, "agentonic_admin")
  expect(
    (
      await command("review.read", {
        submissionId: s.id,
        grantId: r.data.grantId,
      })
    ).ok
  ).toBe(false)
})

it("flushes deferred ownership checks under the restricted app role before commit", async () => {
  const r = await db.query<{ result: { ok: boolean } }>(
    "SELECT agentonic.access_command('agent.create',$1::jsonb,$2::uuid) result",
    [
      JSON.stringify({
        name: "Commit boundary fixture",
        slug: "commit-boundary",
        templateVersionId: template,
      }),
      id(999),
    ]
  )
  expect(r.rows[0]!.result.ok).toBe(true)
  await expect(db.exec("SET CONSTRAINTS ALL IMMEDIATE")).resolves.toBeDefined()
})
it("identity discovery exposes only the current user's active workspace summaries", async () => {
  const r = await db.query<{
    overview: {
      user: { id: string }
      staff: unknown
      workspaces: { id: string }[]
    }
  }>("SELECT agentonic.identity_overview() overview")
  expect(r.rows[0]!.overview.user.id).toBe(owner)
  expect(r.rows[0]!.overview.workspaces.map((w) => w.id)).toEqual([w])
  expect(r.rows[0]!.overview.staff).toBeNull()
  expect(JSON.stringify(r.rows)).not.toContain(otherW)
  await actor(other, w)
  const otherIdentity = await db.query<{
    overview: { workspaces: { id: string }[] }
  }>("SELECT agentonic.identity_overview() overview")
  expect(otherIdentity.rows[0]!.overview.workspaces.map((w) => w.id)).toEqual([
    otherW,
  ])
})
it("identity discovery does not imply staff membership and rejects disabled identities", async () => {
  await actor(staff, w, "agentonic_admin")
  const r = await db.query<{
    overview: { staff: { id: string }; workspaces: unknown[] }
  }>("SELECT agentonic.identity_overview() overview")
  expect(r.rows[0]!.overview.staff.id).toBe(staff)
  expect(r.rows[0]!.overview.workspaces).toEqual([])
  await actor(staff)
  expect(
    (
      await db.query<{ overview: { staff: unknown } }>(
        "SELECT agentonic.identity_overview() overview"
      )
    ).rows[0]!.overview.staff
  ).toBeNull()
  await sql(
    "UPDATE agentonic.workspace_members SET status='removed',removed_at=now() WHERE id=$1",
    [member]
  )
  await sql("UPDATE agentonic.users SET deleted_at=now() WHERE id=$1", [owner])
  await actor()
  expect(
    (
      await db.query<{ overview: unknown }>(
        "SELECT agentonic.identity_overview() overview"
      )
    ).rows[0]!.overview
  ).toEqual({ user: null, staff: null, workspaces: [] })
})
it("identity discovery immediately excludes a suspended workspace", async () => {
  await sql("UPDATE agentonic.workspaces SET status='suspended' WHERE id=$1", [
    w,
  ])
  await actor()
  expect(
    (
      await db.query<{ overview: { workspaces: unknown[] } }>(
        "SELECT agentonic.identity_overview() overview"
      )
    ).rows[0]!.overview.workspaces
  ).toEqual([])
})

it("lists saved counts without returning prompt or skill text", async () => {
  await save()
  const rows = await db.query<{
    result: {
      configuration: {
        promptCharacters: number
        skillsCount: number
        collectionsCount: number
        toolsCount: number
        connectionsCount: number
        liveVersion: null
        reviewVersions: unknown[]
      }
    }[]
  }>("SELECT agentonic.agent_listing() result")
  expect(rows.rows[0]!.result[0]!.configuration).toEqual({
    promptCharacters: content.systemPrompt.replace(/\s/gu, "").length,
    skillsCount: 1,
    collectionsCount: 1,
    toolsCount: 0,
    connectionsCount: 0,
    liveVersion: null,
    reviewVersions: [],
  })
  expect(JSON.stringify(rows.rows)).not.toContain(content.systemPrompt)
  expect(JSON.stringify(rows.rows)).not.toContain(
    content.skills[0]!.instructions
  )
})
it("lists only active submitted versions and removes withdrawn versions", async () => {
  const submission = await submit()
  const listing = async () =>
    (
      await db.query<{
        result: {
          configuration: {
            reviewVersions: { revision: number; status: string }[]
          }
        }[]
      }>("SELECT agentonic.agent_listing() result")
    ).rows[0]!.result[0]!.configuration.reviewVersions
  expect(await listing()).toMatchObject([{ revision: 1, status: "submitted" }])
  await command("submission.withdraw", { submissionId: submission.id })
  expect(await listing()).toEqual([])
})
it("does not list another workspace's agents or permit missing workspace context", async () => {
  await actor(other, otherW)
  expect(
    (
      await db.query<{ result: unknown[] }>(
        "SELECT agentonic.agent_listing() result"
      )
    ).rows[0]!.result
  ).toEqual([])
  await actor(owner, otherW)
  await expect(db.query("SELECT agentonic.agent_listing()")).rejects.toThrow()
})
it("hides configuration summaries from metadata-only collaborators", async () => {
  await save()
  await sql(
    `INSERT INTO agentonic.workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')`,
    [id(103), w, other]
  )
  await sql(
    `INSERT INTO agentonic.agent_member_grants(workspace_id,agent_id,member_id,role,granted_by_member_id) VALUES($1,$2,$3,'viewer',$4)`,
    [w, a, id(103), member]
  )
  await actor(other, w)
  const r = await db.query<{
    result: { canEdit: boolean; configuration: unknown }[]
  }>("SELECT agentonic.agent_listing() result")
  expect(r.rows[0]!.result).toMatchObject([
    { canEdit: false, configuration: null },
  ])
})
it("counts Unicode characters consistently and treats an unsaved agent as empty", async () => {
  const listing = async () =>
    (
      await db.query<{
        result: {
          configuration: {
            promptCharacters: number
            skillsCount: number
            collectionsCount: number
          }
        }[]
      }>("SELECT agentonic.agent_listing() result")
    ).rows[0]!.result[0]!.configuration
  expect(await listing()).toMatchObject({
    promptCharacters: 0,
    skillsCount: 0,
    collectionsCount: 0,
  })
  await command("draft.save", {
    agentId: a,
    revision: 0,
    content: { ...content, systemPrompt: "a\u00a0b\uFEFFc\n😀" },
    requestedAccess: requested,
  })
  expect((await listing()).promptCharacters).toBe(4)
})

async function queue() {
  const result = await db.query<{ result: unknown }>(
    "SELECT agentonic.review_queue() result"
  )
  return reviewQueue.parse(result.rows[0]!.result)
}
it("returns submitter metadata and the prepared version number without exposing content or opening a grant", async () => {
  await sql(
    "UPDATE auth.users SET email='submitter@example.invalid',email_confirmed_at=now() WHERE id=$1",
    [owner]
  )
  await actor()
  await save()
  await command("candidate.freeze", {
    agentId: a,
    revision: 1,
    codeReleaseId: code,
  })
  await save(1)
  const frozen = await command("candidate.freeze", {
    agentId: a,
    revision: 2,
    codeReleaseId: code,
  })
  const submission = await command("submission.send", {
    candidateId: frozen.id,
    consent: true,
    note: "Synthetic note",
  })
  await actor(staff, w, "agentonic_admin")
  const rows = await queue()
  expect(rows).toEqual([
    {
      id: submission.id,
      agentName: "Synthetic agent",
      number: 1,
      versionNumber: 2,
      status: "submitted",
      userId: owner,
      userName: "Owner",
      userEmail: "submitter@example.invalid",
      canOpen: true,
    },
  ])
  const grants = await sql(
    "SELECT count(*)::int n FROM agentonic.support_access_grants"
  )
  expect(grants.rows[0]).toEqual({ n: 0 })
})
it("retains closed review metadata and workspace discovery without reopening private content", async () => {
  const submission = await submit()
  await command("submission.withdraw", { submissionId: submission.id })
  await actor(staff, w, "agentonic_admin")
  expect(await queue()).toMatchObject([{ status: "withdrawn", canOpen: false }])
  const workspaces = await db.query(
    "SELECT * FROM agentonic.review_workspaces()"
  )
  expect(workspaces.rows).toEqual([{ id: w, name: "A" }])
  expect(
    (await command("review.open", { submissionId: submission.id })).ok
  ).toBe(false)
})
it("keeps metadata scoped to the selected workspace and denies non-staff", async () => {
  await submit()
  await actor(staff, otherW, "agentonic_admin")
  expect(await queue()).toEqual([])
  await actor(owner, w, "agentonic_admin")
  await expect(queue()).rejects.toMatchObject({ code: "42501" })
})
it("denies customer and worker execution and direct identity-bridge access", async () => {
  const privileges = await sql(`SELECT
    has_function_privilege('agentonic_customer','agentonic.review_queue()','EXECUTE') customer,
    has_function_privilege('agentonic_worker','agentonic.review_queue()','EXECUTE') worker,
    has_function_privilege('agentonic_admin','agentonic_bootstrap.review_user_email(uuid)','EXECUTE') bridge`)
  expect(privileges.rows[0]).toEqual({
    customer: false,
    worker: false,
    bridge: false,
  })
})
it("revocation disables opening while retaining operational history", async () => {
  await submit()
  await sql("UPDATE agentonic.agents SET archived_at=now() WHERE id=$1", [a])
  await actor(staff, w, "agentonic_admin")
  expect(await queue()).toMatchObject([{ canOpen: false }])
})

it("denies disabled staff even with an admin connection", async () => {
  await submit()
  await sql(
    "UPDATE agentonic.platform_staff SET disabled_at=now() WHERE id=$1",
    [staff]
  )
  await actor(staff, w, "agentonic_admin")
  await expect(queue()).rejects.toMatchObject({ code: "42501" })
})
it("does not return an unconfirmed Auth email", async () => {
  await sql(
    "UPDATE auth.users SET email='pending@example.invalid' WHERE id=$1",
    [owner]
  )
  await actor()
  await submit()
  await actor(staff, w, "agentonic_admin")
  expect(await queue()).toMatchObject([{ userEmail: null }])
})
