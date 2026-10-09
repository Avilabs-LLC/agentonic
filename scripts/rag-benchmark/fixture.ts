import { readFileSync } from "node:fs"
import type { PGlite } from "@electric-sql/pglite"
import assert from "node:assert/strict"
import { readdirSync } from "node:fs"
import { preparedDatabase } from "../prepared-database"

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
const embedding = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))
export async function createRagFixture() {
  let db!: PGlite
  async function actor(
    user = owner,
    workspace = w,
    role = "agentonic_customer"
  ) {
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
  async function sql<T = Record<string, unknown>>(
    q: string,
    params: unknown[] = []
  ) {
    await db.exec("RESET ROLE")
    return db.query<T>(q, params)
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
    assert.equal(frozen.ok, true)
    return command("submission.send", {
      candidateId: frozen.id,
      note: "Please review",
      consent: true,
    })
  }
  async function initialize() {
    db = await preparedDatabase([
      `CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
 CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE ROLE agentonic_migrator;
 CREATE ROLE agentonic_admin NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_customer NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_worker NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_eval_local; CREATE ROLE agentonic_eval_azure; CREATE ROLE agentonic_deployer_local; CREATE ROLE agentonic_deployer_azure; CREATE ROLE agentonic_runtime_local; CREATE ROLE agentonic_runtime_azure;
 CREATE SCHEMA agentonic_bootstrap;
 CREATE FUNCTION agentonic_bootstrap.link_auth_users() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $f$ ALTER TABLE agentonic.users ADD CONSTRAINT users_auth_user_fk FOREIGN KEY(auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT; $f$;
 CREATE SCHEMA storage; CREATE TABLE storage.buckets(id text PRIMARY KEY,public boolean,file_size_limit bigint); INSERT INTO storage.buckets VALUES('agentonic-documents',false,10485760);
 CREATE TABLE storage.objects(id uuid DEFAULT gen_random_uuid(),bucket_id text,name text,metadata jsonb); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY; GRANT USAGE ON SCHEMA storage TO authenticated; GRANT SELECT,INSERT,UPDATE,DELETE ON storage.objects TO authenticated;`,
      readFileSync("scripts/sql/storage-boundary.sql", "utf8"),
      ...readdirSync("packages/database/prisma/migrations")
        .filter((name) => /^\d/.test(name))
        .sort()
        .map((migration) =>
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
 INSERT INTO agentonic.code_releases(id,version,template_version_id,git_commit_sha,artifact_sha256,registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,artifact_key,artifact_size_bytes,published_by_staff_id) VALUES('${code}','0.1.0','${template}',repeat('a',40),repeat('b',64),repeat('c',64),'0.1','${id(60)}','synthetic','fixture',100,'${staff}');
 INSERT INTO agentonic.workspace_code_release_grants(workspace_id,code_release_id,granted_by_staff_id) VALUES('${w}','${code}','${staff}');
 INSERT INTO agentonic.agents(id,workspace_id,name,slug,owner_member_id,template_version_id,created_by_member_id) VALUES('${a}','${w}','Synthetic agent','synthetic','${member}','${template}','${member}');
 INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,owner_member_id) VALUES('${collection}','${w}','Knowledge','knowledge','${member}');`,
    ])
    await db.exec("RESET ROLE;BEGIN")
    await actor()
  }
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
    assert.equal(r.ok, true)
    await sql(
      'INSERT INTO storage.objects(bucket_id,name,metadata) VALUES(\'agentonic-documents\',$1,\'{"size":120,"mimetype":"text/markdown"}\')',
      [`${w}/${r.id}`]
    )
    await actor()
    assert.equal(
      (await command("upload.complete", { objectId: r.id })).ok,
      true
    )
    return r.id
  }
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
  await initialize()
  return {
    db,
    actor,
    command,
    sql,
    submit,
    worker,
    claim,
    rag,
    upload,
    publish,
  }
}
export { id, w, otherW, owner, other, staff, member, collection, embedding }
