import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  root,
  loadLocal,
  connect,
  bootstrapConfig,
  fail,
} from "./local-config.mjs"
// Installs a catalogued runtime artifact next to the ones already installed and
// registers it for the environment's deployment host and evaluator. Brokers and
// evaluators load artifacts by hash for every turn, so nothing restarts and no
// running deployment or queued evaluation changes runtime. `--retire` withdraws
// a host artifact; the database refuses while a deployment still uses it.
const azure = process.argv.includes("--azure"),
  local = process.argv.includes("--local"),
  retire = process.argv.includes("--retire")
assert.ok(azure !== local, "Choose --local or --azure")
assert.equal(bootstrapConfig().ref, "jkgdxkacariasunhentd")
const runtimeHash = process.argv
  .find((x) => x.startsWith("--runtime-sha256="))
  ?.split("=")[1]
assert.match(runtimeHash ?? "", /^[a-f0-9]{64}$/, "Supply --runtime-sha256")
const environment = azure ? "azure_staging" : "local"
const sha = (x) => createHash("sha256").update(x).digest("hex")
const ssh = (script) =>
  execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "vm-agents-01", "sudo", "-n", "bash", "-se"],
    { input: script, stdio: ["pipe", "pipe", "pipe"] }
  )
    .toString()
    .trim()
let db
try {
  const migration = loadLocal(".env.database.local")
  db = await connect(
    migration.AGENTONIC_MIGRATION_DATABASE_URL,
    migration.AGENTONIC_DATABASE_CA_FILE
  )
  const host = (
    await db.query(
      "SELECT id FROM agentonic.runtime_hosts WHERE environment=$1 AND revoked_at IS NULL",
      [environment]
    )
  ).rows[0]
  assert.ok(host, "Install the staging host first")
  if (retire) {
    const retired = await db.query(
      "UPDATE agentonic.runtime_host_artifacts SET retired_at=clock_timestamp() WHERE host_id=$1 AND runtime_sha256=$2 AND retired_at IS NULL",
      [host.id, runtimeHash]
    )
    assert.equal(retired.rowCount, 1, "Runtime not installed on this host")
    console.log(JSON.stringify({ retired: true, environment, runtimeHash }))
  } else {
    // Only reviewed, catalogued artifacts are installed, byte for byte.
    const directory = join(root, ".local/runtime", runtimeHash)
    const raw = readFileSync(join(directory, "manifest.json"))
    assert.equal(sha(raw), runtimeHash)
    const manifest = JSON.parse(raw)
    assert.equal(manifest.previewContract, "1")
    for (const [file, hash] of Object.entries(manifest.files))
      assert.equal(sha(readFileSync(join(directory, file))), hash)
    const release = await db.query(
      "SELECT count(*)::int n FROM agentonic.code_releases WHERE artifact_sha256=$1 AND revoked_at IS NULL",
      [runtimeHash]
    )
    assert.ok(release.rows[0].n > 0, "Register the code release first")
    if (azure) {
      const target = `/opt/agentonic/runtime/artifacts/${runtimeHash}`
      const upload = execFileSync(
        "ssh",
        ["vm-agents-01", "mktemp", "-d", "/tmp/agentonic-runtime.XXXXXXXX"],
        { stdio: ["ignore", "pipe", "ignore"] }
      )
        .toString()
        .trim()
      assert.match(upload, /^\/tmp\/agentonic-runtime\.[a-zA-Z0-9]{8}$/)
      try {
        execFileSync(
          "scp",
          ["-q", "-r", directory, `vm-agents-01:${upload}/`],
          {
            stdio: "ignore",
          }
        )
        const checks = ["manifest.json", ...Object.keys(manifest.files)]
          .map((file) => {
            assert.match(file, /^[a-z0-9_./-]+$/)
            assert.ok(!file.split("/").includes(".."))
            const hash =
              file === "manifest.json" ? runtimeHash : manifest.files[file]
            return `test "$(sha256sum ${target}/${file} | cut -d' ' -f1)" = '${hash}'\n`
          })
          .join("")
        ssh(
          `test "$(hostname)" = vm-agents-01\nif test ! -d ${target}; then cp -R ${upload}/${runtimeHash} ${target}; fi\nchown -R root:root ${target}\nfind ${target} -type d -exec chmod 0555 {} +\nfind ${target} -type f -exec chmod 0444 {} +\n${checks}`
        )
      } finally {
        ssh(`rm -rf -- ${upload}\n`)
      }
    }
    await db.query("BEGIN")
    await db.query(
      "INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [host.id, runtimeHash]
    )
    assert.equal(
      (
        await db.query(
          "SELECT count(*)::int n FROM agentonic.runtime_host_artifacts WHERE host_id=$1 AND runtime_sha256=$2 AND retired_at IS NULL",
          [host.id, runtimeHash]
        )
      ).rows[0].n,
      1,
      "This runtime was retired on this host"
    )
    const evaluator = await db.query(
      "INSERT INTO agentonic.evaluation_worker_runtimes(worker_id,runtime_sha256) SELECT id,$2 FROM agentonic.evaluation_workers WHERE database_role=$1 AND revoked_at IS NULL ON CONFLICT DO NOTHING RETURNING worker_id",
      [azure ? "agentonic_eval_azure" : "agentonic_eval_local", runtimeHash]
    )
    await db.query("COMMIT")
    console.log(
      JSON.stringify({
        installed: true,
        environment,
        runtimeHash,
        evaluatorAdded: evaluator.rowCount === 1,
      })
    )
  }
} catch (error) {
  await db?.query("ROLLBACK").catch(() => {})
  fail(error)
} finally {
  await db?.end()
}
