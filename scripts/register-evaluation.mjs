import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import {
  bootstrapConfig,
  loadLocal,
  connect,
  fail,
  root,
  writeLocal,
} from "./local-config.mjs"
let db
try {
  const { ref } = bootstrapConfig()
  assert.equal(ref, "jkgdxkacariasunhentd")
  const proof = JSON.parse(
    readFileSync(join(root, ".local/evaluation/staging/attestation.json"))
  )
  assert.equal(proof.host, "vm-agents-01")
  assert.equal(proof.environment, "azure_staging")
  assert.match(proof.workerSha256, /^[a-f0-9]{64}$/)
  assert.match(proof.runtimeSha256, /^[a-f0-9]{64}$/)
  assert.ok(Date.now() - Date.parse(proof.verifiedAt) < 3600000)
  assert.ok(
    proof.verification.reviewProtocol === 3 &&
      proof.verification.isolation &&
      proof.verification.recovery &&
      proof.verification.artifactIntegrity
  )
  const observed = execFileSync(
    "ssh",
    [
      "vm-agents-01",
      `systemctl is-active agentonic-evaluator-staging.service && sha256sum /opt/agentonic/evaluation/releases/${proof.workerSha256}/worker.mjs /opt/agentonic/runtime/artifacts/${proof.runtimeSha256}/manifest.json`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  ).toString()
  assert.ok(
    observed.startsWith("active") &&
      observed.includes(proof.workerSha256) &&
      observed.includes(proof.runtimeSha256)
  )
  const env = loadLocal(".env.database.local")
  db = await connect(
    env.AGENTONIC_MIGRATION_DATABASE_URL,
    env.AGENTONIC_DATABASE_CA_FILE
  )
  await db.query("BEGIN")
  const role = "agentonic_eval_azure"
  const existing = await db.query(
    "SELECT * FROM agentonic.evaluation_workers WHERE database_role=$1 AND revoked_at IS NULL AND retired_at IS NULL FOR UPDATE",
    [role]
  )
  // --replace retires the active registrations: normal succession, so approval evidence
  // they produced stays valid. --revoke withdraws trust from everything they produced.
  const revoke = process.argv.includes("--revoke")
  if (existing.rowCount && (process.argv.includes("--replace") || revoke)) {
    assert.equal(
      (
        await db.query(
          "SELECT ((SELECT count(*) FROM agentonic.evaluation_runs WHERE status='running')+(SELECT count(*) FROM agentonic.evaluation_preparations WHERE status='preparing'))::int n"
        )
      ).rows[0].n,
      0
    )
    await db.query(
      revoke
        ? "UPDATE agentonic.evaluation_workers SET revoked_at=clock_timestamp() WHERE revoked_at IS NULL"
        : "UPDATE agentonic.evaluation_workers SET retired_at=clock_timestamp() WHERE revoked_at IS NULL AND retired_at IS NULL"
    )
    existing.rowCount = 0
  }
  // A registration lists every runtime it serves; the measured one is added
  // to an existing registration of the same worker program.
  const serve = (workerId) =>
    db.query(
      "INSERT INTO agentonic.evaluation_worker_runtimes(worker_id,runtime_sha256,verified_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [workerId, proof.runtimeSha256, proof.verifiedAt]
    )
  if (existing.rowCount) {
    assert.equal(existing.rows[0].worker_sha256, proof.workerSha256)
    await serve(existing.rows[0].id)
  } else
    await serve(
      (
        await db.query(
          "INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,verified_at,verification) VALUES($1,$2,$3,$4,$5) RETURNING id",
          [
            role,
            proof.environment,
            proof.workerSha256,
            proof.verifiedAt,
            JSON.stringify(proof.verification),
          ]
        )
      ).rows[0].id
    )
  // Local execution remains useful for development but can never supply Azure evidence.
  const local = await db.query(
    "SELECT id,worker_sha256 FROM agentonic.evaluation_workers WHERE database_role='agentonic_eval_local' AND revoked_at IS NULL AND retired_at IS NULL"
  )
  if (!local.rowCount)
    await serve(
      (
        await db.query(
          "INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,verified_at,verification) VALUES('agentonic_eval_local','local',$1,clock_timestamp(),'{\"artifactIntegrity\":true}') RETURNING id",
          [proof.workerSha256]
        )
      ).rows[0].id
    )
  else {
    assert.equal(local.rows[0].worker_sha256, proof.workerSha256)
    await serve(local.rows[0].id)
  }
  await db.query("COMMIT")
  const credentials = loadLocal(".env.evaluation.local"),
    keys = loadLocal("apps/worker/.env.local")
  writeLocal("apps/worker/.env.evaluation.local", {
    DATABASE_URL: credentials.AGENTONIC_EVAL_LOCAL_DATABASE_URL,
    AGENTONIC_DATABASE_CA_FILE: credentials.AGENTONIC_DATABASE_CA_FILE,
    AGENTONIC_RUNTIME_ROOT: join(root, ".local/runtime"),
    AGENTONIC_EVALUATION_WORKER_SHA256: proof.workerSha256,
    OPENAI_API_KEY: keys.OPENAI_API_KEY,
    VOYAGE_API_KEY: keys.VOYAGE_API_KEY,
    AGENTONIC_RERANK_ENABLED:
      keys.AGENTONIC_RERANK_ENABLED === "true" ? "true" : "false",
  })
  console.log(
    "Measured staging evaluator registered. Separate local evaluator profile prepared; provider usage preserved."
  )
} catch (error) {
  await db?.query("ROLLBACK")
  fail(error)
} finally {
  await db?.end()
}
