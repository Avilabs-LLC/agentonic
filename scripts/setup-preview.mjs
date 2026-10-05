import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import {
  bootstrapConfig,
  loadLocal,
  connect,
  fail,
  root,
} from "./local-config.mjs"
// Registers the runtime package (packages/runtime) as an executable code
// release for the two configured nonproduction workspaces. Releases built here
// name this repository and subdirectory as their source; repository identity
// is immutable, so they use their own template. Agents created earlier keep
// their template and runtime. Existing candidates and provider usage are kept.
const REPOSITORY_URL = "https://github.com/Avilabs-LLC/agentonic"
const SUBDIRECTORY = "packages/runtime"
const TEMPLATE_SLUG = "agentonic-assistant"
const sha = (value) => createHash("sha256").update(value).digest("hex")
const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim()
let bootstrap, db
try {
  assert.equal(git("status", "--porcelain"), "")
  assert.equal(
    git("remote", "get-url", "origin"),
    "git@github.com:Avilabs-LLC/agentonic.git"
  )
  const packaged = JSON.parse(
    execFileSync(
      process.execPath,
      [join(root, "scripts/package-runtime.mjs")],
      {
        stdio: ["ignore", "pipe", "pipe"],
      }
    ).toString()
  )
  const raw = readFileSync(join(packaged.directory, "manifest.json"))
  const manifest = JSON.parse(raw)
  const commit = git("rev-parse", "HEAD")
  assert.equal(sha(raw), packaged.artifactSha256)
  assert.equal(manifest.gitCommit, commit)
  assert.equal(manifest.previewContract, "1")
  assert.equal(manifest.brokerProtocol, "2")
  assert.equal(manifest.model, "gpt-4.1-mini-2025-04-14")
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    "prompts/platform.md",
    "src/surfaces/preview.mjs",
  ])
  for (const [path, hash] of Object.entries(manifest.files))
    assert.equal(sha(readFileSync(join(packaged.directory, path))), hash)
  const source = join(root, SUBDIRECTORY)
  const rawTemplate = readFileSync(join(source, "template.manifest.json"))
  const template = JSON.parse(rawTemplate)
  assert.equal(
    template.platformPolicyText,
    readFileSync(join(packaged.directory, "prompts/platform.md"), "utf8")
  )
  const runtimeVersion = JSON.parse(
    readFileSync(join(source, "package.json"), "utf8")
  ).version
  assert.match(runtimeVersion, /^\d+\.\d+\.\d+$/)

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
      [REPOSITORY_URL]
    )
  ).rows[0]
  if (!repository)
    repository = (
      await db.query(
        "INSERT INTO agentonic.code_repositories(name,repository_url,repository_subdirectory,visibility,provisioning_status,created_by_staff_id) VALUES('Agentonic runtime',$1,$2,'platform','ready',$3) RETURNING *",
        [REPOSITORY_URL, SUBDIRECTORY, staff.rows[0].id]
      )
    ).rows[0]
  assert.equal(repository.repository_subdirectory, SUBDIRECTORY)
  assert.equal(repository.visibility, "platform")
  assert.equal(repository.provisioning_status, "ready")
  let agentTemplate = (
    await db.query("SELECT * FROM agentonic.agent_templates WHERE slug=$1", [
      TEMPLATE_SLUG,
    ])
  ).rows[0]
  if (!agentTemplate)
    agentTemplate = (
      await db.query(
        "INSERT INTO agentonic.agent_templates(slug,name,code_repository_id) VALUES($1,'Asistente personalizable',$2) RETURNING *",
        [TEMPLATE_SLUG, repository.id]
      )
    ).rows[0]
  assert.equal(agentTemplate.code_repository_id, repository.id)
  // Agents stay on their template version and choose among its releases, so
  // every runtime release for configuration contract 0.1 publishes under the
  // same template version. That is what lets an agent move to a newer runtime.
  let version = (
    await db.query(
      "SELECT * FROM agentonic.template_versions WHERE template_id=$1 AND runtime_contract_version='0.1' ORDER BY created_at LIMIT 1",
      [agentTemplate.id]
    )
  ).rows[0]
  if (!version)
    version = (
      await db.query(
        "INSERT INTO agentonic.template_versions(template_id,version,git_commit_sha,manifest_sha256,structure_manifest,runtime_contract_version) VALUES($1,'0.1.0',$2,$3,$4::jsonb,'0.1') RETURNING *",
        [agentTemplate.id, commit, sha(rawTemplate), rawTemplate.toString()]
      )
    ).rows[0]
  assert.equal(
    version.structure_manifest.platformPolicyText,
    template.platformPolicyText
  )
  const releaseVersion = `${runtimeVersion}-preview-${commit.slice(0, 8)}`
  let release = (
    await db.query(
      "SELECT id,artifact_sha256 FROM agentonic.code_releases WHERE code_repository_id=$1 AND version=$2",
      [repository.id, releaseVersion]
    )
  ).rows[0]
  if (!release)
    release = (
      await db.query(
        "INSERT INTO agentonic.code_releases(version,template_version_id,git_commit_sha,artifact_sha256,registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,artifact_key,artifact_size_bytes,published_by_staff_id,execution_manifest) VALUES($1,$2,$3,$4,$5,'0.1',$6,'local-preview',$4,$7,$8,$9::jsonb) RETURNING id,artifact_sha256",
        [
          releaseVersion,
          version.id,
          commit,
          packaged.artifactSha256,
          sha(readFileSync(join(source, "src/tools/registry.ts"))),
          repository.id,
          raw.length +
            Object.keys(manifest.files).reduce(
              (n, p) => n + readFileSync(join(packaged.directory, p)).length,
              0
            ),
          staff.rows[0].id,
          JSON.stringify(manifest),
        ]
      )
    ).rows[0]
  assert.equal(release.artifact_sha256, packaged.artifactSha256)
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
    JSON.stringify({
      registered: releaseVersion,
      artifactSha256: packaged.artifactSha256,
      next: "pnpm runtime:install --local|--azure --runtime-sha256=<artifactSha256>",
    })
  )
} catch (error) {
  await db?.query("ROLLBACK")
  fail(error)
} finally {
  await bootstrap?.end()
  await db?.end()
}
