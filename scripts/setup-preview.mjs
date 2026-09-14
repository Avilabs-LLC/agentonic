import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { resolve, join } from "node:path"
import {
  bootstrapConfig,
  loadLocal,
  connect,
  fail,
  root,
} from "./local-config.mjs"
const sha = (value) => createHash("sha256").update(value).digest("hex")
const checkout = resolve(process.argv[2] ?? join(root, "../agentonic-runtime"))
const git = (...args) =>
  execFileSync("git", ["-C", checkout, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim()
let bootstrap, db
try {
  assert.equal(git("status", "--porcelain"), "")
  assert.equal(
    git("remote", "get-url", "origin"),
    "git@github.com:Avilabs-LLC/agentonic-runtime.git"
  )
  const packaged = JSON.parse(
    execFileSync(
      process.execPath,
      [
        join(checkout, "scripts/package-preview.mjs"),
        join(root, ".local/runtime"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    ).toString()
  )
  const raw = readFileSync(join(packaged.directory, "manifest.json"))
  const manifest = JSON.parse(raw)
  assert.equal(sha(raw), packaged.artifactSha256)
  assert.equal(manifest.gitCommit, git("rev-parse", "HEAD"))
  assert.equal(manifest.previewContract, "1")
  assert.equal(manifest.model, "gpt-4.1-mini-2025-04-14")
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    "prompts/platform.md",
    "src/surfaces/preview.mjs",
  ])
  for (const [path, hash] of Object.entries(manifest.files))
    assert.equal(sha(readFileSync(join(packaged.directory, path))), hash)
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
  const template = (
    await db.query(
      "SELECT v.id,v.structure_manifest,t.code_repository_id FROM agentonic.template_versions v JOIN agentonic.agent_templates t ON t.id=v.template_id WHERE t.slug='agentonic-base' AND v.runtime_contract_version='0.1' ORDER BY v.created_at LIMIT 1"
    )
  ).rows[0]
  assert.ok(template)
  assert.equal(
    template.structure_manifest.platformPolicyText,
    readFileSync(join(packaged.directory, "prompts/platform.md"), "utf8")
  )
  const version = `0.2.0-preview-${manifest.gitCommit.slice(0, 8)}`
  let release = (
    await db.query(
      "SELECT id,artifact_sha256 FROM agentonic.code_releases WHERE code_repository_id=$1 AND version=$2",
      [template.code_repository_id, version]
    )
  ).rows[0]
  if (!release)
    release = (
      await db.query(
        "INSERT INTO agentonic.code_releases(version,template_version_id,git_commit_sha,artifact_sha256,registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,artifact_key,artifact_size_bytes,published_by_staff_id,execution_manifest) VALUES($1,$2,$3,$4,$5,'0.1',$6,'local-preview',$4,$7,$8,$9::jsonb) RETURNING id,artifact_sha256",
        [
          version,
          template.id,
          manifest.gitCommit,
          packaged.artifactSha256,
          sha(readFileSync(join(checkout, "src/tools/registry.ts"))),
          template.code_repository_id,
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
    `Registered local preview runtime ${version} for the two configured nonproduction workspaces. Existing candidates and provider allowances were preserved.`
  )
} catch (error) {
  await db?.query("ROLLBACK")
  fail(error)
} finally {
  await bootstrap?.end()
  await db?.end()
}
