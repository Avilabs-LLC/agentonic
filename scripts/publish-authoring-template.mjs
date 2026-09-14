import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { gunzipSync } from "node:zlib"
import {
  bootstrapConfig,
  loadLocal,
  connect,
  fail,
  root,
} from "./local-config.mjs"
const repo = "Avilabs-LLC/agentonic-runtime",
  tag = "v0.1.0-authoring",
  filename = "runtime-0.1.0-authoring.tar.gz"
const checkout = resolve(process.argv[2] ?? join(root, "../agentonic-runtime"))
const git = (...args) =>
  execFileSync("git", ["-C", checkout, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  })
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
let bootstrap, db, temporary
try {
  assert.equal(git("status", "--porcelain").toString().trim(), "")
  assert.equal(
    git("remote", "get-url", "origin").toString().trim(),
    "git@github.com:Avilabs-LLC/agentonic-runtime.git"
  )
  const commit = git("rev-parse", "HEAD").toString().trim()
  const remote = git("ls-remote", "origin", `refs/tags/${tag}`)
    .toString()
    .trim()
    .split(/\s/)[0]
  assert.equal(remote, commit)
  const info = JSON.parse(
    execFileSync("gh", ["repo", "view", repo, "--json", "isPrivate"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
  )
  assert.equal(info.isPrivate, true)
  const rawManifest = git("show", `${commit}:template.manifest.json`)
  const manifest = JSON.parse(rawManifest)
  assert.equal(manifest.executionAvailable, false)
  assert.equal(manifest.configurationVersion, 1)
  assert.deepEqual(manifest.tools, [])
  assert.equal(
    manifest.platformPolicyText,
    git("show", `${commit}:prompts/platform.md`).toString()
  )
  const registry = git("show", `${commit}:src/tools/registry.ts`)
  temporary = mkdtempSync(join(tmpdir(), "agentonic-authoring-"))
  const file = join(temporary, filename)
  execFileSync(
    "gh",
    [
      "release",
      "download",
      tag,
      "--repo",
      repo,
      "--pattern",
      filename,
      "--output",
      file,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  const artifact = readFileSync(file)
  assert.ok(
    gunzipSync(artifact, { maxOutputLength: 16777216 }).equals(
      git("archive", "--format=tar", "--prefix=agentonic-runtime/", commit)
    )
  )
  const { e } = bootstrapConfig()
  bootstrap = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  const staff = await bootstrap.query(
    "SELECT s.id,u.id user_id FROM agentonic.platform_staff s JOIN agentonic.users u ON u.id=s.user_id JOIN auth.users a ON a.id=u.auth_user_id WHERE lower(a.email)=lower($1) AND s.role='administrator' AND s.disabled_at IS NULL AND u.deleted_at IS NULL",
    [e.AGENTONIC_BOOTSTRAP_STAFF_EMAIL]
  )
  assert.equal(staff.rowCount, 1)
  const workspaces = await bootstrap.query(
    "SELECT id FROM agentonic.workspaces WHERE slug=ANY($1::text[]) AND status='active'",
    [["bootstrap-customer-a", "bootstrap-customer-b"]]
  )
  assert.equal(workspaces.rowCount, 2)
  await bootstrap.end()
  bootstrap = null
  const env = loadLocal(".env.database.local")
  db = await connect(
    env.AGENTONIC_MIGRATION_DATABASE_URL,
    env.AGENTONIC_DATABASE_CA_FILE
  )
  await db.query("BEGIN")
  let repository = (
    await db.query(
      "SELECT * FROM agentonic.code_repositories WHERE repository_url=$1",
      ["https://github.com/Avilabs-LLC/agentonic-runtime"]
    )
  ).rows[0]
  if (!repository)
    repository = (
      await db.query(
        "INSERT INTO agentonic.code_repositories(name,repository_url,visibility,provisioning_status,created_by_staff_id) VALUES('Agentonic runtime',$1,'platform','ready',$2) RETURNING *",
        ["https://github.com/Avilabs-LLC/agentonic-runtime", staff.rows[0].id]
      )
    ).rows[0]
  assert.equal(repository.visibility, "platform")
  assert.equal(repository.provisioning_status, "ready")
  let template = (
    await db.query(
      "SELECT * FROM agentonic.agent_templates WHERE slug='agentonic-base'"
    )
  ).rows[0]
  if (!template)
    template = (
      await db.query(
        "INSERT INTO agentonic.agent_templates(slug,name,code_repository_id) VALUES('agentonic-base','Asistente personalizable',$1) RETURNING *",
        [repository.id]
      )
    ).rows[0]
  assert.equal(template.code_repository_id, repository.id)
  let version = (
    await db.query(
      "SELECT * FROM agentonic.template_versions WHERE template_id=$1 AND version='0.1.0'",
      [template.id]
    )
  ).rows[0]
  if (!version)
    version = (
      await db.query(
        "INSERT INTO agentonic.template_versions(template_id,version,git_commit_sha,manifest_sha256,structure_manifest,runtime_contract_version) VALUES($1,'0.1.0',$2,$3,$4::jsonb,'0.1') RETURNING *",
        [template.id, commit, sha(rawManifest), JSON.stringify(manifest)]
      )
    ).rows[0]
  assert.equal(version.git_commit_sha, commit)
  assert.equal(version.manifest_sha256, sha(rawManifest))
  let release = (
    await db.query(
      "SELECT * FROM agentonic.code_releases WHERE code_repository_id=$1 AND version='0.1.0-authoring'",
      [repository.id]
    )
  ).rows[0]
  if (!release)
    release = (
      await db.query(
        "INSERT INTO agentonic.code_releases(version,template_version_id,git_commit_sha,artifact_sha256,registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,artifact_key,artifact_size_bytes,published_by_staff_id) VALUES('0.1.0-authoring',$1,$2,$3,$4,'0.1',$5,'github-releases',$6,$7,$8) RETURNING *",
        [
          version.id,
          commit,
          sha(artifact),
          sha(registry),
          repository.id,
          `${repo}/${tag}/${filename}`,
          artifact.length,
          staff.rows[0].id,
        ]
      )
    ).rows[0]
  assert.equal(release.artifact_sha256, sha(artifact))
  assert.equal(release.git_commit_sha, commit)
  for (const w of workspaces.rows) {
    const granted = await db.query(
      "INSERT INTO agentonic.workspace_code_release_grants(workspace_id,code_release_id,granted_by_staff_id) VALUES($1,$2,$3) ON CONFLICT(workspace_id,code_release_id) DO NOTHING RETURNING id",
      [w.id, release.id, staff.rows[0].id]
    )
    if (granted.rowCount)
      await db.query(
        "INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,action,resource_type,resource_id,outcome) VALUES($1,$2,'catalog.publish','code_release',$3,'succeeded')",
        [w.id, staff.rows[0].user_id, release.id]
      )
  }
  await db.query("COMMIT")
  console.log(
    "Verified private authoring artifact registered for the two configured nonproduction workspaces. No agents or deployments were created."
  )
} catch (error) {
  await db?.query("ROLLBACK")
  fail(error)
} finally {
  await bootstrap?.end()
  await db?.end()
  if (temporary) rmSync(temporary, { recursive: true, force: true })
}
