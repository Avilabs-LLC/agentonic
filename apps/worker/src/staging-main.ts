import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readdirSync,
  lstatSync,
  chmodSync,
} from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import { parse } from "dotenv"
import pg from "pg"
import { z } from "zod"
import { logJob } from "./job-log"
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
  DROP_IN_BROKERS,
  FULL_POLL_MS,
  HEARTBEAT_MS,
  metadata,
  pollResult,
  restDue,
  type ControllerSystem,
  type Deployment,
} from "./staging-controller"
import { GatewayClient, createGateway, jobCall } from "./gateway"
import {
  directProviders,
  gatewayCapabilities,
  gatewayProviders,
  gatewaySend,
  providerGateway,
  providerKeys,
  type Providers,
} from "./providers"
import { PreviewFailure, TurnFailure } from "./failure"
// One program, three services: the host's deployment controller (--manager),
// its gateway (--gateway: database connections and provider keys) and one agent
// copy per deployment, which holds neither.
const manager = process.argv.includes("--manager")
const gateway = process.argv.includes("--gateway")
const self = fileURLToPath(import.meta.url)
const packaged = self.endsWith("/broker.mjs")
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const serviceName = manager
  ? "deployment-controller"
  : gateway
    ? "database-gateway"
    : "agent-service"

/** Socket paths longer than the platform limit (104 bytes on macOS) are silently cut short. */
const socketPath = (path: string) =>
  isAbsolute(path) && Buffer.byteLength(path) <= 100

// A configuration or integrity problem cannot fix itself: report it and exit so
// systemd's start limit turns it into a visible failed unit.
function configure() {
  try {
    const configFile = process.env.CREDENTIALS_DIRECTORY
      ? join(process.env.CREDENTIALS_DIRECTORY, "config")
      : process.env.AGENTONIC_STAGING_CONFIG
    if (!configFile) throw new Error("configuration_invalid")
    const env = { ...parse(readFileSync(configFile)), ...process.env }
    const brokerHash = env.AGENTONIC_BROKER_SHA256 ?? ""
    if (!hash.safeParse(brokerHash).success)
      throw new Error("configuration_invalid")
    // Packaged execution verifies its own reviewed bytes before touching deployment state.
    if (packaged && digest(readFileSync(self)) !== brokerHash)
      throw new Error("broker_mismatch")
    const root = env.AGENTONIC_INSTANCE_ROOT ?? "",
      runtimeRoot = env.AGENTONIC_RUNTIME_ROOT ?? ""
    if (!gateway && (!root || !runtimeRoot))
      throw new Error("configuration_invalid")
    // Agent copies reach the database and providers only through the host's gateway.
    if (!manager && !gateway) {
      const socket = env.AGENTONIC_GATEWAY_SOCKET ?? ""
      if (!socketPath(socket)) throw new Error("configuration_invalid")
      return { env, root, runtimeRoot, brokerHash, socket, local: false }
    }
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
const settings = configure()
const { env, root, runtimeRoot, brokerHash, local } = settings
// The gateway holds the connections for every copy on its host; the controller needs two.
const connections = gateway
  ? z.coerce
      .number()
      .int()
      .min(1)
      .max(12)
      .catch(5)
      .parse(env.AGENTONIC_GATEWAY_CONNECTIONS ?? 5)
  : 2
const pool =
  "url" in settings && settings.url
    ? new pg.Pool({
        host: settings.url.hostname,
        port: Number(settings.url.port || 5432),
        user: decodeURIComponent(settings.url.username),
        password: decodeURIComponent(settings.url.password),
        database: decodeURIComponent(settings.url.pathname.slice(1)),
        ssl: { rejectUnauthorized: true, ca: settings.ca },
        max: connections,
        connectionTimeoutMillis: 10000,
        statement_timeout: 30000,
      })
    : undefined
const database = () => {
  if (!pool) throw new Error("configuration_invalid")
  return pool
}
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
// A copy's frozen release (manifest and generated assets), which systemd loads
// into its credentials (LoadCredential=release:, scripts/staging-units.mjs).
const releaseCredentials = (broker: string, id: string) =>
  join(serviceRoot, hash.parse(broker), z.uuid().parse(id))
const startable = (broker: string) => local || !DROP_IN_BROKERS.has(broker)
const releaseDirectory = (d: Deployment) =>
  join(root, d.workspaceId, d.agentId, d.environment, "releases", d.id)
async function host(
  operation: string,
  id: string | null = null,
  payload: Record<string, unknown> = {}
) {
  const r = await database().query(
    "SELECT agentonic.deployment_host($1,$2,$3) result",
    [operation, id, JSON.stringify({ ...payload, brokerHash })]
  )
  return r.rows[0].result
}
// Active agent units, read with one systemctl call per pass instead of one per deployment.
let activeUnits = new Set<string>()
function readUnits() {
  if (local) return
  activeUnits = new Set(
    execFileSync(
      "systemctl",
      [
        "list-units",
        "--type=service",
        "--state=active",
        "--plain",
        "--no-legend",
        "--no-pager",
        "agentonic-staging-*",
      ],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 20000 }
    )
      .toString()
      .split("\n")
      .map((line) => line.split(/\s+/)[0] ?? "")
      .filter(Boolean)
  )
}
function running(broker: string, id: string) {
  if (local) {
    const child = children.get(`${broker}:${id}`)
    return !!child && child.exitCode === null && child.signalCode === null
  }
  return activeUnits.has(unitName(broker, id))
}
// The controller runs as its own user: polkit lets it start, stop and reset agent copies only.
const systemctl = (...args: string[]) =>
  execFileSync("systemctl", ["--no-ask-password", ...args], {
    stdio: "ignore",
    timeout: 20000,
  })
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
  if (!startable(broker)) throw new Error("broker_unavailable")
  const unit = unitName(broker, id)
  // Written fresh for every start from the installed release; nothing here is a link.
  const credentials = releaseCredentials(broker, id)
  rmSync(credentials, { recursive: true, force: true })
  mkdirSync(credentials, { mode: 0o700 })
  const write = (name: string, from: string) =>
    writeFileSync(join(credentials, name), readFileSync(from), {
      mode: 0o400,
      flag: "wx",
    })
  write("manifest", path)
  for (const asset of manifest.assets)
    write(digest(asset.path), resolve(path, "..", asset.path))
  // The controller paces retries itself; clear systemd's start limit from earlier attempts.
  try {
    systemctl("reset-failed", unit)
  } catch {
    /* Not in a failed state. */
  }
  systemctl("start", unit)
  activeUnits.add(unit)
}
function remove(broker: string, id: string) {
  if (local) {
    children.get(`${broker}:${id}`)?.kill("SIGTERM")
    children.delete(`${broker}:${id}`)
  } else {
    const unit = unitName(broker, id)
    if (running(broker, id)) systemctl("stop", unit)
    activeUnits.delete(unit)
    // A drop-in broker's unit drop-in is root's; the installer removes stale ones.
    rmSync(releaseCredentials(broker, id), { recursive: true, force: true })
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
  startable,
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
  // A full poll every thirty seconds rechecks authority, cleans up content and
  // lists ended deployments; a watch every two seconds finds waiting turns.
  let polled = 0
  while (!stopping) {
    let state: z.infer<typeof pollResult>
    let parsed: Deployment[]
    try {
      const full = Date.now() - polled >= FULL_POLL_MS
      state = pollResult.parse(await host(full ? "poll" : "watch"))
      parsed = state.deployments.map((raw) => metadata.parse(raw))
      readUnits()
      if (full) polled = Date.now()
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
  // systemd loads the release the controller wrote as credentials named release_*.
  const credential = (name: string) =>
    join(env.CREDENTIALS_DIRECTORY ?? "", `release_${name}`)
  const manifestPath = env.CREDENTIALS_DIRECTORY
    ? credential("manifest")
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
      ? credential(digest(asset.path))
      : resolve(manifestPath, "..", asset.path)
    if (digest(readFileSync(path)) !== asset.sha256)
      throw new Error("asset_mismatch")
  }
  const service = async (operation: string) =>
    (await calls.call("deployment_service", [
      operation,
      id,
      secret,
      JSON.stringify({
        manifestHash: env.AGENTONIC_MANIFEST_HASH,
        brokerHash,
      }),
    ])) as {
      ok: boolean
      code?: string
      draining?: boolean
    }
  const execute: Execute = async (operation, job, payload = {}) =>
    (await calls.call(jobCall(operation), [
      operation,
      id,
      secret,
      job.id,
      job.token,
      JSON.stringify(payload),
    ])) as Record<string, unknown>
  // Provider calls run at the gateway, which holds the keys and uses this copy's credentials.
  const send = gatewaySend(calls, id, secret)
  // A refused secret never becomes valid again and an unavailable deployment is
  // the controller's to handle: both end this copy cleanly. Outages are waited out.
  let providers: Providers | undefined
  while (!stopping) {
    try {
      const available = await gatewayCapabilities(send)
      const ready = await service("ready")
      if (!ready.ok) return life.stopped(ready.code ?? "unavailable")
      providers = gatewayProviders(send, available)
      life.recovered()
      break
    } catch (error) {
      if (categorize(error) === "refused") return life.stopped("copy_refused")
      await pause(life.waiting(reasonOf(error)))
    }
  }
  if (!providers) return life.stopped("stop_requested")
  life.started()
  // Claims run every two seconds, reports every ten. An idle copy rests: the
  // controller starts it again when a turn waits for it.
  let reported = 0
  let lastWork = Date.now()
  let served = false
  while (!stopping) {
    let job: Lease | null
    try {
      if (Date.now() - reported >= HEARTBEAT_MS) {
        const beat = await service("heartbeat")
        if (!beat.ok) return life.stopped(beat.code ?? "unavailable")
        // A copy on a newer broker serves now, and this one holds no lease.
        if (beat.draining) return life.stopped("drained")
        reported = Date.now()
      }
      job = (await calls.call("staging_worker", [
        "claim",
        id,
        secret,
        null,
        null,
        "{}",
      ])) as Lease | null
      if (!job && restDue(Date.now() - lastWork, served)) {
        const rest = await service("rest")
        if (rest.ok) return life.stopped("resting")
        // A turn arrived meanwhile ("pending"): claim it on the next round.
        if (rest.code !== "pending")
          return life.stopped(rest.code ?? "unavailable")
      }
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
    served = true
    const lease = job
    const startedAt = Date.now()
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
          runtimeRoot,
          rerankEnabled: env.AGENTONIC_RERANK_ENABLED === "true",
          stream: true,
          providers,
        },
        controller.signal
      )
      logJob({
        service: "staging_turn",
        job: lease,
        deploymentId: id,
        startedAt,
        finishedAt: Date.now(),
      })
    } catch (error) {
      const code = error instanceof Error ? error.message : "lease_lost"
      // A refused record leaves the turn to the host's next poll (§84).
      const recorded = await execute("fail", lease, { code }).then(
        () => true,
        () => false
      )
      logJob({
        service: "staging_turn",
        job: lease,
        deploymentId: id,
        startedAt,
        finishedAt: Date.now(),
        code,
        diagnostic:
          error instanceof TurnFailure || error instanceof PreviewFailure
            ? error.diagnostic
            : undefined,
        recordRefused: !recorded,
      })
    } finally {
      clearInterval(timer)
      active = undefined
      lastWork = Date.now()
    }
  }
}

// ---------------------------------------------------------------------------
// Database gateway: the host's connections, shared by every agent copy on it

async function gatewayLoop() {
  const life = new ServiceState(serviceName, {
    broker: brokerHash.slice(0, 12),
    connections,
  })
  const db = database()
  // The host's provider keys stay in this process. Each provider call runs with
  // the calling copy's own deployment credentials (providers.ts).
  const query = async (text: string, values: unknown[]) =>
    (await db.query(text, values)).rows[0]?.result
  const provider = providerGateway(directProviders(providerKeys(env)), query)
  const server = createGateway(
    query,
    {
      // Only the database being unreachable or busy is the gateway's state; a
      // refused or malformed call is the calling copy's own outcome.
      failed: (code) => {
        const reason = categorize({ code })
        if (reason === "database_unreachable" || reason === "database_busy")
          life.waiting(reason, FAST)
      },
      succeeded: () => life.recovered(),
    },
    () => db.waitingCount,
    provider
  )
  // systemd passes the listening socket (socket activation); local runs bind a private path.
  const activated =
    process.env.LISTEN_FDS === "1" &&
    process.env.LISTEN_PID === String(process.pid)
  const path = env.AGENTONIC_GATEWAY_SOCKET ?? ""
  if (!activated) {
    if (!socketPath(path)) throw new Error("configuration_invalid")
    rmSync(path, { force: true })
  }
  // A listening server keeps the process alive, so it is closed on every way out.
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(activated ? { fd: 3 } : { path }, () => resolve())
    })
    if (!activated) chmodSync(path, 0o600)
    life.started()
    await new Promise<void>((resolve) => {
      if (halt.signal.aborted) resolve()
      halt.signal.addEventListener("abort", () => resolve(), { once: true })
    })
  } finally {
    server.shutdown()
  }
  life.stopped("stop_requested")
}

// Only agent copies call through the gateway; it connects on first use.
const calls = new GatewayClient(settings.socket ?? "")
try {
  await (manager ? managerLoop() : gateway ? gatewayLoop() : serviceLoop())
} catch (error) {
  new ServiceState(serviceName).stopped(reasonOf(error))
  process.exitCode = 1
} finally {
  for (const child of children.values()) child.kill("SIGTERM")
  calls.close()
  await pool?.end()
}
