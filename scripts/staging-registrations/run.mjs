// Re-verifies the existing staging installations and renews their seven-day registrations.
// Never rebuilds, reinstalls, resets usage or revives a revoked registration. Every run
// also reports the health of the Azure services (waiting, failed or restarting) and
// whether this Mac still holds the bytes needed to rebuild vm-agents-01.
//
//   pnpm staging:reverify                      show registrations and expiry (read-only)
//   pnpm staging:reverify --verify             run every check, change nothing
//   pnpm staging:reverify --renew              re-verify and renew what expires within 2 days
//   pnpm staging:reverify --renew --now        ... even if not yet due
//   pnpm staging:reverify --renew --only=local-host   name targets (also revives an expired local one)
//   pnpm staging:reverify --renew --publish    also publish the report for the GitHub alert workflow
//   pnpm staging:reverify --schedule | --unschedule   install/remove the twice-daily job on this Mac
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parse } from "dotenv"
import {
  bootstrapConfig,
  connect,
  fail,
  loadLocal,
  root,
} from "../local-config.mjs"
import { stagingUnits } from "../staging-units.mjs"
import {
  NODE,
  TARGETS,
  azureEvaluatorChecks,
  azureHostChecks,
  failedChecks,
  gatherScript,
  healthFindings,
  healthProbes,
  isEvaluator,
  localEvaluatorChecks,
  localHostChecks,
  machineNotes,
  parseFacts,
  planRenewal,
  problems,
  utc,
  validUntil,
} from "./policy.ts"

const REPO = "Avilabs-LLC/agentonic"
const VARIABLE = "STAGING_REGISTRATIONS"
const WORKFLOW = "staging-registrations.yml"
const LABEL = "com.avilabs.agentonic.staging-reverify"
const FLAGS = ["verify", "renew", "now", "publish", "schedule", "unschedule"]
const args = process.argv.slice(2)
for (const arg of args)
  assert.ok(
    FLAGS.includes(arg.slice(2)) || arg.startsWith("--only="),
    `Unknown option ${arg}`
  )
const flag = (name) => args.includes(`--${name}`)
const only = args
  .find((arg) => arg.startsWith("--only="))
  ?.slice(7)
  .split(",")
for (const target of only ?? [])
  assert.ok(TARGETS.includes(target), `Unknown target ${target}`)
const sha = (value) => createHash("sha256").update(value).digest("hex")

if (flag("schedule") || flag("unschedule")) {
  schedule(flag("schedule"))
  process.exit(0)
}

const lockPath = join(root, ".local/staging/reverify.lock")
let db,
  locked = false
try {
  assert.equal(bootstrapConfig().ref, "jkgdxkacariasunhentd")
  if (flag("renew")) lock()
  const env = loadLocal(".env.database.local")
  db = await connect(
    env.AGENTONIC_MIGRATION_DATABASE_URL,
    env.AGENTONIC_DATABASE_CA_FILE
  )
  const registrations = await load()
  const now = new Date()
  const entries = []
  for (const target of TARGETS) {
    const registration = registrations[target]
    const current = registration
      ? validUntil(registration.verifiedAt).toISOString()
      : null
    const plan = planRenewal({
      target,
      registration,
      now,
      selected: only,
      anyTime: flag("now"),
    })
    if (!flag("renew") && !flag("verify")) {
      entries.push({
        name: target,
        validUntil: current,
        outcome: standing(registration, now),
      })
      continue
    }
    const act = flag("verify")
      ? !["missing", "revoked", "retired", "not_selected"].includes(plan.reason)
      : plan.renew
    if (!act) {
      entries.push({
        name: target,
        validUntil: current,
        outcome: standing(registration, now),
        ...(plan.reason === "expired_local"
          ? { detail: `renew with --renew --only=${target}` }
          : {}),
      })
      continue
    }
    entries.push(
      await reverify(target, registration, current).catch((error) => {
        // Keep going so the report still publishes and the alert fires.
        if (process.env.REVERIFY_DEBUG) console.error(error)
        return {
          name: target,
          validUntil: current,
          outcome: "failed",
          detail: "unexpected error in the re-verification script",
        }
      })
    )
  }
  // Health is read last, after any renewal had its chance to bring services back.
  const machine = health(registrations, entries, now)
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    registrations: entries,
    ...(machine.length ? { machine } : {}),
  }
  print(entries, now, machine)
  if (flag("publish")) publish(report)
  const found = problems(report, new Date())
  if (found.length || entries.some((entry) => entry.outcome === "failed"))
    process.exitCode = 1
} catch (error) {
  fail(error)
} finally {
  await db?.end()
  if (locked) unlinkSync(lockPath)
}

function standing(registration, now) {
  if (!registration) return "missing"
  if (registration.revokedAt) return "revoked"
  if (registration.retiredAt) return "retired"
  return validUntil(registration.verifiedAt) > now ? "valid" : "expired"
}

async function load() {
  const hosts = (
    await db.query(
      "SELECT id,environment,broker_sha256,verified_at,revoked_at FROM agentonic.runtime_hosts"
    )
  ).rows
  // Broker releases side by side; retired and revoked ones run no copies.
  const brokers = (
    await db.query(
      "SELECT host_id,broker_sha256 FROM agentonic.runtime_host_brokers WHERE retired_at IS NULL AND revoked_at IS NULL ORDER BY broker_sha256"
    )
  ).rows
  // Runtime artifacts served side by side; retired ones are no longer checked.
  const artifacts = (
    await db.query(
      "SELECT host_id,runtime_sha256 FROM agentonic.runtime_host_artifacts WHERE retired_at IS NULL ORDER BY runtime_sha256"
    )
  ).rows
  // Latest registration per evaluator role: the active one if any, otherwise the last ended one.
  const workers = (
    await db.query(
      "SELECT DISTINCT ON (database_role) id,database_role,worker_sha256,verified_at,revoked_at,retired_at,verification FROM agentonic.evaluation_workers ORDER BY database_role,(revoked_at IS NULL AND retired_at IS NULL) DESC,created_at DESC"
    )
  ).rows
  const workerRuntimes = (
    await db.query(
      "SELECT worker_id,runtime_sha256 FROM agentonic.evaluation_worker_runtimes ORDER BY runtime_sha256"
    )
  ).rows
  const host = (environment) => {
    const row = hosts.find((h) => h.environment === environment)
    return (
      row && {
        id: row.id,
        verifiedAt: row.verified_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
        codeSha256: row.broker_sha256,
        brokers: brokers
          .filter((b) => b.host_id === row.id)
          .map((b) => b.broker_sha256),
        runtimes: artifacts
          .filter((a) => a.host_id === row.id)
          .map((a) => a.runtime_sha256),
      }
    )
  }
  const worker = (role) => {
    const row = workers.find((w) => w.database_role === role)
    return (
      row && {
        id: row.id,
        verifiedAt: row.verified_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
        retiredAt: row.retired_at?.toISOString() ?? null,
        codeSha256: row.worker_sha256,
        runtimes: workerRuntimes
          .filter((r) => r.worker_id === row.id)
          .map((r) => r.runtime_sha256),
        verification: row.verification,
      }
    )
  }
  return {
    "azure-host": host("azure_staging") ?? null,
    "azure-evaluator": worker("agentonic_eval_azure") ?? null,
    "local-host": host("local") ?? null,
    "local-evaluator": worker("agentonic_eval_local") ?? null,
  }
}

/** The frozen runtime's file list, trusted only after its manifest hash matches. */
function runtimeFiles(runtimeSha256) {
  const raw = readFileSync(
    join(root, ".local/runtime", runtimeSha256, "manifest.json")
  )
  assert.equal(sha(raw), runtimeSha256)
  return JSON.parse(raw).files
}

function checksFor(target, registration) {
  const common = {
    runtimes: registration.runtimes.map((sha256) => ({
      sha256,
      files: runtimeFiles(sha256),
    })),
  }
  if (target === "azure-host") {
    const units = (broker) =>
      stagingUnits({
        broker,
        serviceRoot: "/etc/agentonic/staging/agents",
        caPath: "/etc/agentonic/staging/database-ca.crt",
        configRoot: "/etc/agentonic/staging",
      })
    return azureHostChecks({
      ...common,
      brokerSha256: registration.codeSha256,
      brokers: registration.brokers.map((broker) => ({
        sha256: broker,
        templateSha256: sha(units(broker).runtime),
      })),
      controllerUnitSha256: sha(units(registration.codeSha256).controller),
    })
  }
  if (target === "azure-evaluator") {
    assert.match(
      String(registration.verification?.unitSha256),
      /^[a-f0-9]{64}$/
    )
    return azureEvaluatorChecks({
      ...common,
      workerSha256: registration.codeSha256,
      unitSha256: registration.verification.unitSha256,
    })
  }
  if (target === "local-host")
    return localHostChecks({
      ...common,
      root,
      brokerSha256: registration.codeSha256,
      brokers: registration.brokers,
    })
  return localEvaluatorChecks({
    ...common,
    root,
    workerSha256: registration.codeSha256,
  })
}

/** Runs a root script on the VM. Connection and sudo failures surface as `vm_unreachable`. */
function ssh(script) {
  try {
    return execFileSync(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=20",
        "vm-agents-01",
        "sudo",
        "-n",
        "bash",
        "-s",
      ],
      { input: script, stdio: ["pipe", "pipe", "pipe"], timeout: 180_000 }
    ).toString()
  } catch {
    throw new Error("vm_unreachable")
  }
}

function gatherLocal(checks) {
  const facts = {}
  for (const { key } of checks) {
    const kind = key.slice(0, key.indexOf(":")),
      arg = key.slice(key.indexOf(":") + 1)
    if (kind === "sha")
      facts[key] = existsSync(arg) ? sha(readFileSync(arg)) : "missing"
    else if (kind === "mode")
      facts[key] = existsSync(arg)
        ? (statSync(arg).mode & 0o777).toString(8)
        : "missing"
    else if (kind === "env") {
      const [file, name] = arg.split("#")
      facts[key] = existsSync(file)
        ? parse(readFileSync(file))[name]
        : undefined
    } else throw new Error(`Unknown local fact ${kind}`)
  }
  return facts
}

function summarize(names) {
  return names.length > 4
    ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more`
    : names.join(", ")
}

async function reverify(target, registration, current) {
  const entry = (outcome, detail, until = current) => ({
    name: target,
    validUntil: until,
    outcome,
    ...(detail ? { detail } : {}),
  })
  let checks
  try {
    checks = checksFor(target, registration)
  } catch {
    return entry(
      "failed",
      "expected installation unknown on this Mac (runtime manifest or unit hash)"
    )
  }
  let facts
  try {
    facts = target.startsWith("azure-")
      ? parseFacts(ssh(gatherScript(checks)))
      : gatherLocal(checks)
  } catch (error) {
    if (error?.message !== "vm_unreachable") throw error
    return entry("failed", "could not reach vm-agents-01 with sudo")
  }
  const failed = failedChecks(checks, facts)
  if (failed.length) return entry("failed", summarize(failed))
  if (flag("verify")) return entry("verified")
  const names = checks.map((check) => check.name)
  try {
    return isEvaluator(target)
      ? await renewEvaluator(target, registration, names, entry)
      : await renewHost(target, registration, entry)
  } catch (error) {
    const code = /^[a-z_]+$/.test(error?.message ?? "")
      ? error.message
      : "renewal_error"
    return entry("failed", code.replaceAll("_", " "))
  }
}

async function renewHost(target, registration, entry) {
  const updated = await db.query(
    "UPDATE agentonic.runtime_hosts h SET verified_at=clock_timestamp() WHERE id=$1 AND revoked_at IS NULL AND broker_sha256=$2 AND coalesce((SELECT array_agg(runtime_sha256 ORDER BY runtime_sha256) FROM agentonic.runtime_host_artifacts WHERE host_id=h.id AND retired_at IS NULL),'{}')=$3::text[] AND coalesce((SELECT array_agg(broker_sha256 ORDER BY broker_sha256) FROM agentonic.runtime_host_brokers WHERE host_id=h.id AND retired_at IS NULL AND revoked_at IS NULL),'{}')=$4::text[] RETURNING verified_at",
    [
      registration.id,
      registration.codeSha256,
      registration.runtimes,
      registration.brokers,
    ]
  )
  if (updated.rowCount !== 1)
    throw new Error("registration_changed_during_check")
  const verifiedAt = updated.rows[0].verified_at
  const until = validUntil(verifiedAt.toISOString()).toISOString()
  // A healthy controller heartbeats every few seconds; an expired one restarts every ten.
  const controllerExpected = target === "azure-host" || localControllerAlive()
  if (!controllerExpected) return entry("renewed", undefined, until)
  for (let waited = 0; waited < 60_000; waited += 3000) {
    const beat = await db.query(
      "SELECT heartbeat_at FROM agentonic.runtime_hosts WHERE id=$1",
      [registration.id]
    )
    if (beat.rows[0]?.heartbeat_at > verifiedAt)
      return entry("renewed", undefined, until)
    await delay(3000)
  }
  return entry(
    "renewed",
    "the deployment controller has not resumed within 60 s",
    until
  )
}

function localControllerAlive() {
  try {
    process.kill(
      Number(readFileSync(join(root, ".local/staging/manager.pid"), "utf8")),
      0
    )
    return true
  } catch {
    return false
  }
}

async function renewEvaluator(target, registration, names, entry) {
  const azure = target === "azure-evaluator"
  // A restart must not interrupt Azure work; revocation must not orphan this worker's leases.
  const busy = await db.query(
    azure
      ? "SELECT ((SELECT count(*) FROM agentonic.evaluation_runs WHERE environment='azure_staging' AND status IN ('queued','running'))+(SELECT count(*) FROM agentonic.evaluation_preparations WHERE status IN ('queued','preparing')))::int n"
      : "SELECT ((SELECT count(*) FROM agentonic.evaluation_runs WHERE worker_id=$1 AND status='running')+(SELECT count(*) FROM agentonic.evaluation_preparations WHERE worker_id=$1 AND status='preparing'))::int n",
    azure ? [] : [registration.id]
  )
  if (busy.rows[0].n) return entry("deferred", "an evaluation is in progress")
  // Renewal retires the registration: approval evidence it produced stays valid.
  let restart = false
  if (azure) {
    const release = `/opt/agentonic/evaluation/releases/${registration.codeSha256}`
    const out = parseFacts(
      ssh(
        `set -u\nunit=agentonic-evaluator-staging.service\nold=$(systemctl show -p MainPID --value $unit)\nsystemctl restart $unit\nsleep 3\nnew=$(systemctl show -p MainPID --value $unit)\nprintf 'old\\t%s\\nnew\\t%s\\nstate\\t%s\\n' "$old" "$new" "$(systemctl is-active $unit)"\nif [ "\${new:-0}" -gt 0 ]; then printf 'command\\t%s\\n' "$(tr '\\0' ' ' < /proc/$new/cmdline)"; fi\n`
      )
    )
    if (
      !(Number(out.new) > 0) ||
      out.new === out.old ||
      out.state !== "active" ||
      out.command !== `${NODE} ${release}/worker.mjs`
    )
      return entry("failed", "evaluator did not restart cleanly")
    restart = true
  }
  await db.query("BEGIN")
  try {
    const locked = await db.query(
      "SELECT * FROM agentonic.evaluation_workers WHERE id=$1 AND revoked_at IS NULL AND retired_at IS NULL FOR UPDATE",
      [registration.id]
    )
    const row = locked.rows[0]
    const runtimes = (
      await db.query(
        "SELECT runtime_sha256 FROM agentonic.evaluation_worker_runtimes WHERE worker_id=$1 ORDER BY runtime_sha256",
        [registration.id]
      )
    ).rows.map((r) => r.runtime_sha256)
    if (
      !row ||
      row.worker_sha256 !== registration.codeSha256 ||
      runtimes.join() !== registration.runtimes.join()
    )
      throw new Error("registration_changed_during_check")
    const leased = await db.query(
      "SELECT ((SELECT count(*) FROM agentonic.evaluation_runs WHERE worker_id=$1 AND status='running')+(SELECT count(*) FROM agentonic.evaluation_preparations WHERE worker_id=$1 AND status='preparing'))::int n",
      [row.id]
    )
    if (leased.rows[0].n) throw new Error("evaluation_started_during_check")
    await db.query(
      "UPDATE agentonic.evaluation_workers SET retired_at=clock_timestamp() WHERE id=$1",
      [row.id]
    )
    // Registrations are immutable; renewal records a new one carrying the installation's
    // original attestation plus what this re-verification checked.
    const verification = {
      ...row.verification,
      reverification: {
        version: 1,
        previousRegistrationId: row.id,
        restartVerified: restart,
        checks: names,
      },
    }
    const inserted = await db.query(
      "INSERT INTO agentonic.evaluation_workers(database_role,environment,worker_sha256,verified_at,verification) VALUES($1,$2,$3,clock_timestamp(),$4) RETURNING id,verified_at",
      [
        row.database_role,
        row.environment,
        row.worker_sha256,
        JSON.stringify(verification),
      ]
    )
    // The renewed registration serves exactly the runtimes just re-verified.
    await db.query(
      "INSERT INTO agentonic.evaluation_worker_runtimes(worker_id,runtime_sha256,verified_at) SELECT $1,unnest($2::text[]),clock_timestamp()",
      [inserted.rows[0].id, runtimes]
    )
    await db.query("COMMIT")
    return entry(
      "renewed",
      undefined,
      validUntil(inserted.rows[0].verified_at.toISOString()).toISOString()
    )
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {})
    throw error
  }
}

/**
 * Gathers service health for the Azure targets in one SSH session and checks that this
 * Mac still holds every program and runtime the VM serves, so it could be rebuilt.
 * Adds findings to the entries; returns notes about the machine.
 */
function health(registrations, entries, now) {
  const targets = ["azure-host", "azure-evaluator"].filter(
    (target) => registrations[target] && !standingEnded(registrations[target])
  )
  if (!targets.length) return []
  let facts = null
  try {
    facts = parseFacts(
      ssh(gatherScript(targets.flatMap((target) => healthProbes(target))))
    )
  } catch {
    /* Reported per target below. */
  }
  for (const target of targets) {
    const found = facts
      ? healthFindings(target, facts)
      : ["could not reach vm-agents-01 with sudo"]
    const missing = missingLocally(target, registrations[target])
    if (missing.length)
      found.push(
        `this Mac no longer holds what rebuilding it needs: ${summarize(missing)}`
      )
    const entry = entries.find((e) => e.name === target)
    if (entry && found.length) entry.health = found
  }
  return facts ? machineNotes(facts, now) : []
}

function standingEnded(registration) {
  return !!(registration.revokedAt || registration.retiredAt)
}

/** Program and runtime bytes the VM serves that are missing or altered on this Mac. */
function missingLocally(target, registration) {
  const programs =
    target === "azure-host"
      ? registration.brokers.map((broker) => [
          `broker ${broker.slice(0, 12)}`,
          join(root, ".local/staging/releases", broker, "broker.mjs"),
          broker,
        ])
      : [
          [
            `evaluator ${registration.codeSha256.slice(0, 12)}`,
            join(
              root,
              ".local/evaluation/releases",
              registration.codeSha256,
              "worker.mjs"
            ),
            registration.codeSha256,
          ],
        ]
  const missing = programs
    .filter(
      ([, path, hash]) => !existsSync(path) || sha(readFileSync(path)) !== hash
    )
    .map(([name]) => name)
  for (const runtime of registration.runtimes)
    try {
      for (const [path, hash] of Object.entries(runtimeFiles(runtime)))
        if (
          sha(readFileSync(join(root, ".local/runtime", runtime, path))) !==
          hash
        )
          throw new Error("changed")
    } catch {
      missing.push(`runtime ${runtime.slice(0, 12)}`)
    }
  return missing
}

function print(entries, now, machine = []) {
  const left = (until) => {
    if (!until) return "—"
    const ms = Date.parse(until) - now.getTime()
    if (ms <= 0) return "expired"
    const hours = Math.floor(ms / 3_600_000)
    return `${Math.floor(hours / 24)}d ${hours % 24}h`
  }
  console.log(`Staging registrations, ${utc(now.toISOString())}`)
  for (const entry of entries)
    console.log(
      [
        entry.name.padEnd(16),
        (entry.validUntil ? utc(entry.validUntil) : "—").padEnd(21),
        left(entry.validUntil).padEnd(8),
        entry.outcome + (entry.detail ? `: ${entry.detail}` : ""),
      ].join("  ")
    )
  for (const note of machine) console.log(`  ${note}`)
  for (const line of problems(
    { version: 1, generatedAt: now.toISOString(), registrations: entries },
    now
  ))
    console.log(`! ${line}`)
}

/** Publishes the content-free report; the GitHub workflow turns problems into an assigned issue. */
function publish(report) {
  const gh = (...command) =>
    execFileSync("gh", command, { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim()
  try {
    const assignee = gh("api", "user", "--jq", ".login")
    gh(
      "variable",
      "set",
      VARIABLE,
      "--repo",
      REPO,
      "--body",
      JSON.stringify({ ...report, assignee })
    )
  } catch {
    console.log(
      "! Could not publish the report to GitHub; the alert workflow will treat it as stale."
    )
    process.exitCode = 1
    return
  }
  try {
    gh("workflow", "run", WORKFLOW, "--repo", REPO, "--ref", "main")
    console.log("Report published; alert workflow started.")
  } catch {
    console.log(
      "Report published. The alert workflow is not on main yet; it will run on its schedule once merged."
    )
  }
}

function lock() {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600)
      writeFileSync(fd, String(process.pid))
      closeSync(fd)
      locked = true
      return
    } catch {
      let alive = false
      try {
        process.kill(Number(readFileSync(lockPath, "utf8")), 0)
        alive = true
      } catch {
        /* A stale lock from a crashed run is removed below. */
      }
      assert.ok(!alive, "Another re-verification is running")
      unlinkSync(lockPath)
    }
  }
  throw new Error("Could not acquire the re-verification lock")
}

function schedule(install) {
  const uid = process.getuid()
  const plist = join(homedir(), "Library/LaunchAgents", `${LABEL}.plist`)
  try {
    execFileSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], {
      stdio: "ignore",
    })
  } catch {
    /* Not loaded. */
  }
  if (!install) {
    if (existsSync(plist)) unlinkSync(plist)
    console.log("Scheduled re-verification removed.")
    return
  }
  const gh = execFileSync("/usr/bin/which", ["gh"]).toString().trim()
  const log = join(root, ".local/staging/reverify.log")
  const xml = (value) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
  const string = (value) => `<string>${xml(value)}</string>`
  const program = [
    process.execPath,
    "--import",
    "tsx",
    join(root, "scripts/staging-registrations/run.mjs"),
    "--renew",
    "--publish",
  ]
  const path = [
    ...new Set([
      dirname(process.execPath),
      dirname(gh),
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ]),
  ].join(":")
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(LABEL)}
  <key>ProgramArguments</key>
  <array>${program.map(string).join("")}</array>
  <key>WorkingDirectory</key>${string(root)}
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key>${string(path)}</dict>
  <key>StartCalendarInterval</key>
  <array>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>0</integer></dict>
    <dict><key>Hour</key><integer>21</integer><key>Minute</key><integer>0</integer></dict>
  </array>
  <key>StandardOutPath</key>${string(log)}
  <key>StandardErrorPath</key>${string(log)}
</dict>
</plist>
`,
    { mode: 0o644 }
  )
  execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plist])
  console.log(
    `Scheduled at 09:00 and 21:00 local time (runs on wake if missed). Log: ${log}`
  )
}
