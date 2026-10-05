import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  lstatSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { parse } from "dotenv"
import pg from "pg"
import { z } from "zod"
import { processJob, type Execute, type Lease } from "./pipeline"
import { verifyRuntime } from "./runtime"
import {
  prepareInstallation,
  switchCurrent,
  manifestSchema,
  digest,
} from "./staging-files"
import {
  FAST,
  Incidents,
  ServiceState,
  categorize,
  reasonOf,
} from "./service-state"
import {
  COPY,
  Controller,
  metadata,
  pollResult,
  type ControllerSystem,
  type Deployment,
} from "./staging-controller"
const manager = process.argv.includes("--manager")
const self = fileURLToPath(import.meta.url)
const packaged = self.endsWith("/broker.mjs")
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const serviceName = manager ? "deployment-controller" : "agent-service"

// A configuration or integrity problem cannot fix itself: report it and exit so
// systemd's start limit turns it into a visible failed unit.
function configure() {
  try {
    const configFile = process.env.CREDENTIALS_DIRECTORY
      ? join(process.env.CREDENTIALS_DIRECTORY, "config")
      : process.env.AGENTONIC_STAGING_CONFIG
    if (!configFile) throw new Error("configuration_invalid")
    const env = { ...parse(readFileSync(configFile)), ...process.env }
    const url = new URL(env.DATABASE_URL ?? "")
    const role = decodeURIComponent(url.username).split(".")[0] ?? ""
    if (
      !(
        manager
          ? ["agentonic_deployer_local", "agentonic_deployer_azure"]
          : ["agentonic_runtime_local", "agentonic_runtime_azure"]
      ).includes(role)
    )
      throw new Error("configuration_invalid")
    const root = env.AGENTONIC_INSTANCE_ROOT,
      runtimeRoot = env.AGENTONIC_RUNTIME_ROOT,
      brokerHash = env.AGENTONIC_BROKER_SHA256
    if (
      !root ||
      !runtimeRoot ||
      !brokerHash ||
      !hash.safeParse(brokerHash).success
    )
      throw new Error("configuration_invalid")
    // Packaged execution verifies its own reviewed bytes before touching deployment state.
    if (packaged && digest(readFileSync(self)) !== brokerHash)
      throw new Error("broker_mismatch")
    const ca = readFileSync(env.AGENTONIC_DATABASE_CA_FILE ?? "", "utf8")
    return {
      env,
      url,
      ca,
      root,
      runtimeRoot,
      brokerHash,
      local: role.endsWith("_local"),
    }
  } catch (error) {
    new ServiceState(serviceName).stopped(
      error instanceof Error && error.message === "broker_mismatch"
        ? "broker_mismatch"
        : "configuration_invalid"
    )
    process.exit(1)
  }
}
const { env, url, ca, root, runtimeRoot, brokerHash, local } = configure()
const pool = new pg.Pool({
  host: url.hostname,
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: decodeURIComponent(url.pathname.slice(1)),
  ssl: { rejectUnauthorized: true, ca },
  max: 2,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
})
let stopping = false
let active: AbortController | undefined
const halt = new AbortController()
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    stopping = true
    active?.abort()
    halt.abort()
  })
/** Waits, but returns at once when the service is asked to stop. */
const pause = (ms: number) =>
  sleep(ms, undefined, { signal: halt.signal }).catch(() => {})

// ---------------------------------------------------------------------------
// Deployment controller: the machine side (systemd units or local child
// processes, private files). Decisions live in staging-controller.ts.

const serviceRoot = env.AGENTONIC_SERVICE_CONFIG_ROOT ?? ""
// Packaged brokers live at <releases>/<hash>/broker.mjs; every release is a sibling.
const releases = dirname(dirname(self))
const children = new Map<string, ChildProcess>()
const unitName = (broker: string, id: string) =>
  `agentonic-staging-${hash.parse(broker)}@${z.uuid().parse(id)}.service`
const copyConfig = (broker: string, id: string) =>
  join(serviceRoot, hash.parse(broker), `${z.uuid().parse(id)}.env`)
const releaseDirectory = (d: Deployment) =>
  join(root, d.workspaceId, d.agentId, d.environment, "releases", d.id)
async function host(
  operation: string,
  id: string | null = null,
  payload: Record<string, unknown> = {}
) {
  const r = await pool.query(
    "SELECT agentonic.deployment_host($1,$2,$3) result",
    [operation, id, JSON.stringify({ ...payload, brokerHash })]
  )
  return r.rows[0].result
}
function running(broker: string, id: string) {
  if (local) {
    const child = children.get(`${broker}:${id}`)
    return !!child && child.exitCode === null && child.signalCode === null
  }
  try {
    return (
      execFileSync("systemctl", ["is-active", unitName(broker, id)], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() === "active"
    )
  } catch {
    return false
  }
}
const systemctl = (...args: string[]) =>
  execFileSync("systemctl", args, { stdio: "ignore", timeout: 20000 })
function start(broker: string, id: string) {
  const settings = parse(readFileSync(copyConfig(broker, id)))
  if (local) {
    const program = packaged ? join(releases, broker, "broker.mjs") : self
    if (!existsSync(program) || (!packaged && broker !== brokerHash))
      throw new Error("broker_unavailable")
    const key = `${broker}:${id}`
    const child = spawn(process.execPath, [program], {
      env: {
        PATH: process.env.PATH,
        AGENTONIC_STAGING_CONFIG: copyConfig(broker, id),
      },
      stdio: "ignore",
    })
    children.set(key, child)
    child.once("exit", () => {
      if (children.get(key) === child) children.delete(key)
    })
    return
  }
  const path = settings.AGENTONIC_MANIFEST_PATH ?? ""
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  if (
    manifest.deploymentId !== id ||
    path !==
      join(
        root,
        manifest.workspaceId,
        manifest.agentId,
        manifest.environment,
        "releases",
        id,
        "manifest.json"
      )
  )
    throw new Error("installation_invalid")
  const unit = unitName(broker, id)
  const override = join("/etc/systemd/system", `${unit}.d`)
  mkdirSync(override, { recursive: true, mode: 0o755 })
  writeFileSync(
    join(override, "release.conf"),
    "[Service]\nLoadCredential=manifest:" +
      path +
      "\n" +
      manifest.assets
        .map(
          (asset) =>
            "LoadCredential=" +
            digest(asset.path) +
            ":" +
            resolve(path, "..", asset.path)
        )
        .join("\n") +
      "\n",
    { mode: 0o644 }
  )
  systemctl("daemon-reload")
  // The controller paces retries itself; clear systemd's start limit from earlier attempts.
  try {
    systemctl("reset-failed", unit)
  } catch {
    /* Not in a failed state. */
  }
  systemctl("start", unit)
}
function remove(broker: string, id: string) {
  if (local) {
    children.get(`${broker}:${id}`)?.kill("SIGTERM")
    children.delete(`${broker}:${id}`)
  } else {
    const unit = unitName(broker, id)
    if (running(broker, id)) systemctl("stop", unit)
    rmSync(join("/etc/systemd/system", `${unit}.d`), {
      recursive: true,
      force: true,
    })
    try {
      systemctl("reset-failed", unit)
    } catch {
      /* Not in a failed state. */
    }
  }
  rmSync(copyConfig(broker, id), { force: true })
}
/** Brokers holding a copy configuration, per deployment. */
function copiesOnDisk() {
  const copies = new Map<string, Set<string>>()
  if (!existsSync(serviceRoot)) return copies
  for (const broker of readdirSync(serviceRoot)) {
    if (!hash.safeParse(broker).success) continue
    for (const file of readdirSync(join(serviceRoot, broker))) {
      const id = file.endsWith(".env") ? file.slice(0, -4) : ""
      if (!z.uuid().safeParse(id).success) continue
      copies.set(id, (copies.get(id) ?? new Set()).add(broker))
    }
  }
  return copies
}
const system: ControllerSystem = {
  brokerHash,
  host,
  brokerConfig: () => parse(readFileSync(env.AGENTONIC_BROKER_CONFIG ?? "")),
  install: (prepared) => prepareInstallation(prepared, root, runtimeRoot),
  switchCurrent: (d) =>
    switchCurrent(
      root,
      manifestSchema.parse(
        JSON.parse(
          readFileSync(join(releaseDirectory(d), "manifest.json"), "utf8")
        )
      )
    ),
  removeAssets: (d) => {
    const dir = releaseDirectory(d)
    if (existsSync(dir) && !lstatSync(dir).isSymbolicLink())
      for (const asset of ["prompts", "skills"])
        if (existsSync(join(dir, asset)))
          rmSync(join(dir, asset), { recursive: true, force: true })
  },
  configure: (broker, id, settings) => {
    mkdirSync(join(serviceRoot, hash.parse(broker)), {
      recursive: true,
      mode: 0o700,
    })
    writeFileSync(
      copyConfig(broker, id),
      Object.entries(settings)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join("\n") + "\n",
      { mode: 0o600, flag: "wx" }
    )
  },
  running,
  start,
  remove,
  secret: () => randomBytes(32).toString("hex"),
  now: Date.now,
}
async function managerLoop() {
  if (!serviceRoot || !env.AGENTONIC_BROKER_CONFIG)
    throw new Error("configuration_invalid")
  mkdirSync(serviceRoot, { recursive: true, mode: 0o700 })
  const life = new ServiceState(serviceName, {
    broker: brokerHash.slice(0, 12),
  })
  const deployments = new Incidents("deployment")
  const controller = new Controller(system)
  life.started()
  while (!stopping) {
    let state: z.infer<typeof pollResult>
    let parsed: Deployment[]
    try {
      state = pollResult.parse(await host("poll"))
      parsed = state.deployments.map((raw) => metadata.parse(raw))
      life.recovered()
    } catch (error) {
      // Expired, revoked or replaced registrations are refused until renewed: wait, don't exit.
      const refused = categorize(error) === "refused"
      await pause(
        life.waiting(
          refused ? "registration_refused" : reasonOf(error),
          refused ? FAST : undefined
        )
      )
      continue
    }
    await controller.pass(
      parsed,
      state.brokers,
      copiesOnDisk(),
      {
        due: (id) => deployments.due(id),
        ok: (id) => deployments.ok(id, { deploymentId: id }),
        fail: async (d, failure) => {
          // A local precheck failure (an installation in progress) is not the deployment's fault.
          if (
            (d.status === "queued" && failure.step !== "precheck") ||
            d.status === "preparing"
          )
            await host("fail", d.id).catch(() => {})
          deployments.fail(
            d.id,
            failure.reason,
            { deploymentId: d.id, step: failure.step },
            COPY
          )
        },
      },
      () => stopping
    )
    if (process.argv.includes("--once")) break
    await pause(2000)
  }
}

// ---------------------------------------------------------------------------
// Agent service: one copy of one deployment

async function serviceLoop() {
  const id = z.uuid().parse(env.AGENTONIC_DEPLOYMENT_ID),
    secret = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(env.AGENTONIC_DEPLOYMENT_SECRET)
  const life = new ServiceState(serviceName, {
    deploymentId: id,
    broker: brokerHash.slice(0, 12),
  })
  const manifestPath = env.CREDENTIALS_DIRECTORY
    ? join(env.CREDENTIALS_DIRECTORY, "manifest")
    : (env.AGENTONIC_MANIFEST_PATH ?? "")
  const raw = readFileSync(manifestPath, "utf8")
  const manifest = manifestSchema.parse(JSON.parse(raw))
  if (
    manifest.deploymentId !== id ||
    digest(raw) !== env.AGENTONIC_MANIFEST_HASH
  )
    throw new Error("manifest_mismatch")
  verifyRuntime(manifest.runtime, runtimeRoot)
  // systemd supplies each generated asset as a private credential; local uses the immutable directory.
  for (const asset of manifest.assets) {
    const path = env.CREDENTIALS_DIRECTORY
      ? join(env.CREDENTIALS_DIRECTORY, digest(asset.path))
      : resolve(manifestPath, "..", asset.path)
    if (digest(readFileSync(path)) !== asset.sha256)
      throw new Error("asset_mismatch")
  }
  const service = async (operation: string) => {
    const r = await pool.query(
      "SELECT agentonic.deployment_service($1,$2,$3,$4) result",
      [
        operation,
        id,
        secret,
        JSON.stringify({
          manifestHash: env.AGENTONIC_MANIFEST_HASH,
          brokerHash,
        }),
      ]
    )
    return r.rows[0].result as {
      ok: boolean
      code?: string
      draining?: boolean
    }
  }
  const execute: Execute = async (operation, job, payload = {}) => {
    const r = await pool.query(
      operation.startsWith("web-")
        ? "SELECT agentonic.web_staging($1,$2,$3,$4,$5,$6) result"
        : operation.startsWith("gmail-")
          ? "SELECT agentonic.gmail_staging($1,$2,$3,$4,$5,$6) result"
          : "SELECT agentonic.staging_worker($1,$2,$3,$4,$5,$6) result",
      [operation, id, secret, job.id, job.token, JSON.stringify(payload)]
    )
    return r.rows[0].result
  }
  // A refused secret never becomes valid again and an unavailable deployment is
  // the controller's to handle: both end this copy cleanly. Outages are waited out.
  while (!stopping) {
    try {
      const ready = await service("ready")
      if (!ready.ok) return life.stopped(ready.code ?? "unavailable")
      life.recovered()
      break
    } catch (error) {
      if (categorize(error) === "refused") return life.stopped("copy_refused")
      await pause(life.waiting(reasonOf(error)))
    }
  }
  life.started()
  while (!stopping) {
    let job: Lease | null
    try {
      const beat = await service("heartbeat")
      if (!beat.ok) return life.stopped(beat.code ?? "unavailable")
      // A copy on a newer broker serves now, and this one holds no lease.
      if (beat.draining) return life.stopped("drained")
      const next = await pool.query(
        "SELECT agentonic.staging_worker('claim',$1,$2,NULL,NULL) result",
        [id, secret]
      )
      job = next.rows[0].result as Lease | null
      life.recovered()
    } catch (error) {
      if (categorize(error) === "refused") return life.stopped("copy_refused")
      await pause(life.waiting(reasonOf(error)))
      continue
    }
    if (!job) {
      await pause(2000)
      continue
    }
    const lease = job
    active = new AbortController()
    const controller = active
    // Draining keeps the lease: only a refused or unavailable deployment aborts the turn.
    const timer = setInterval(() => {
      void Promise.all([
        service("heartbeat"),
        execute("heartbeat", lease),
      ]).then(
        ([beat]) => {
          if (!beat.ok) controller.abort()
        },
        () => controller.abort()
      )
    }, 20000)
    try {
      await processJob(
        lease,
        execute,
        {
          supabaseUrl: "",
          storageKey: "",
          runtimeRoot,
          voyageKey: env.VOYAGE_API_KEY ?? "",
          rerankEnabled: env.AGENTONIC_RERANK_ENABLED === "true",
          openaiKey: env.OPENAI_API_KEY ?? "",
          browserbaseKey: env.BROWSERBASE_API_KEY,
          google:
            env.AGENTONIC_CONNECTION_KEY &&
            env.GOOGLE_CLIENT_ID &&
            env.GOOGLE_CLIENT_SECRET
              ? {
                  clientId: env.GOOGLE_CLIENT_ID,
                  clientSecret: env.GOOGLE_CLIENT_SECRET,
                  encryptionKey: env.AGENTONIC_CONNECTION_KEY,
                  redirectUri:
                    env.GOOGLE_REDIRECT_URI ??
                    "http://localhost:3101/api/connections/google/callback",
                }
              : undefined,
        },
        controller.signal
      )
    } catch (error) {
      const code = error instanceof Error ? error.message : "lease_lost"
      await execute("fail", lease, { code }).catch(() => {})
    } finally {
      clearInterval(timer)
      active = undefined
    }
  }
}
try {
  await (manager ? managerLoop() : serviceLoop())
} catch (error) {
  new ServiceState(serviceName).stopped(reasonOf(error))
  process.exitCode = 1
} finally {
  for (const child of children.values()) child.kill("SIGTERM")
  await pool.end()
}
