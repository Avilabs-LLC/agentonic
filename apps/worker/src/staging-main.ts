import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  lstatSync,
} from "node:fs"
import { join, resolve } from "node:path"
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
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
const configFile = process.env.CREDENTIALS_DIRECTORY
  ? join(process.env.CREDENTIALS_DIRECTORY, "config")
  : process.env.AGENTONIC_STAGING_CONFIG
if (!configFile) throw new Error("Staging configuration required")
const env = { ...parse(readFileSync(configFile)), ...process.env }
const manager = process.argv.includes("--manager")
const url = new URL(env.DATABASE_URL!)
const role = decodeURIComponent(url.username).split(".")[0]
if (
  !(
    manager
      ? ["agentonic_deployer_local", "agentonic_deployer_azure"]
      : ["agentonic_runtime_local", "agentonic_runtime_azure"]
  ).includes(role!)
)
  throw new Error("Restricted staging role required")
const local = role!.endsWith("_local")
const root = env.AGENTONIC_INSTANCE_ROOT!,
  runtimeRoot = env.AGENTONIC_RUNTIME_ROOT!,
  brokerHash = env.AGENTONIC_BROKER_SHA256!
if (!root || !runtimeRoot || !/^[a-f0-9]{64}$/.test(brokerHash))
  throw new Error("Fixed staging installation required")
// Packaged execution verifies its own reviewed bytes before touching deployment state.
if (
  import.meta.url.endsWith("/broker.mjs") &&
  digest(readFileSync(new URL(import.meta.url))) !== brokerHash
)
  throw new Error("Broker hash mismatch")
const pool = new pg.Pool({
  host: url.hostname,
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: decodeURIComponent(url.pathname.slice(1)),
  ssl: {
    rejectUnauthorized: true,
    ca: readFileSync(env.AGENTONIC_DATABASE_CA_FILE!, "utf8"),
  },
  max: 2,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
})
let stopping = false
let active: AbortController | undefined
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    stopping = true
    active?.abort()
  })
const delay = () =>
  new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 2000))
const children = new Map<string, ChildProcess>()
const metadata = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  agentId: z.uuid(),
  environment: z.enum(["local", "azure_staging"]),
  status: z.string(),
  desired: z.enum(["running", "stopped"]),
  heartbeatAt: z.string().nullable(),
})
const serviceName = (id: string) =>
  `agentonic-staging@${z.uuid().parse(id)}.service`
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
function serviceFile(id: string) {
  return join(env.AGENTONIC_SERVICE_CONFIG_ROOT!, `${z.uuid().parse(id)}.env`)
}
function running(id: string) {
  if (local) return !!children.get(id) && children.get(id)!.exitCode === null
  try {
    return (
      execFileSync("systemctl", ["is-active", serviceName(id)], {
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim() === "active"
    )
  } catch {
    return false
  }
}
function start(id: string) {
  if (local) {
    const child = spawn(process.execPath, [new URL(import.meta.url).pathname], {
      env: {
        PATH: process.env.PATH,
        AGENTONIC_STAGING_CONFIG: serviceFile(id),
      },
      stdio: "ignore",
    })
    children.set(id, child)
    child.once("exit", () => {
      if (children.get(id) === child) children.delete(id)
    })
  } else {
    const settings = parse(readFileSync(serviceFile(id)))
    const path = settings.AGENTONIC_MANIFEST_PATH!
    const manifest = manifestSchema.parse(
      JSON.parse(readFileSync(path, "utf8"))
    )
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
      throw new Error("Invalid release path")
    const override = join("/etc/systemd/system", `${serviceName(id)}.d`)
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
    execFileSync("systemctl", ["daemon-reload"], {
      stdio: "ignore",
      timeout: 20000,
    })
    execFileSync("systemctl", ["start", serviceName(id)], {
      stdio: "ignore",
      timeout: 20000,
    })
  }
}
function stop(id: string) {
  if (local) {
    children.get(id)?.kill("SIGTERM")
    children.delete(id)
  } else
    execFileSync("systemctl", ["stop", serviceName(id)], {
      stdio: "ignore",
      timeout: 20000,
    })
}
async function managerLoop() {
  if (!env.AGENTONIC_SERVICE_CONFIG_ROOT || !env.AGENTONIC_BROKER_CONFIG)
    throw new Error("Installer configuration required")
  mkdirSync(env.AGENTONIC_SERVICE_CONFIG_ROOT, { recursive: true, mode: 0o700 })
  while (!stopping) {
    const state = await host("poll")
    for (const raw of state.deployments) {
      const d = metadata.parse(raw)
      const dir = join(
        root,
        d.workspaceId,
        d.agentId,
        d.environment,
        "releases",
        d.id
      )
      try {
        if (d.desired === "stopped") {
          if (running(d.id)) stop(d.id)
          // Retain content-free manifest and usage; remove generated private assets and credentials.
          if (existsSync(dir) && !lstatSync(dir).isSymbolicLink())
            for (const asset of ["prompts", "skills"])
              rmSync(join(dir, asset), { recursive: true, force: true })
          rmSync(serviceFile(d.id), { force: true })
          continue
        }
        if (d.status === "queued") {
          const secret = randomBytes(32).toString("hex")
          const prepared = await host("prepare", d.id, {
            tokenHash: digest(secret),
          })
          const installed = prepareInstallation(prepared, root, runtimeRoot)
          // Customer text never becomes command text, environment entries or an executable.
          const brokerConfig = parse(readFileSync(env.AGENTONIC_BROKER_CONFIG))
          const settings = {
            ...brokerConfig,
            AGENTONIC_DEPLOYMENT_ID: d.id,
            AGENTONIC_DEPLOYMENT_SECRET: secret,
            AGENTONIC_MANIFEST_PATH: join(
              installed.destination,
              "manifest.json"
            ),
            AGENTONIC_MANIFEST_HASH: installed.manifestHash,
          }
          writeFileSync(
            serviceFile(d.id),
            Object.entries(settings)
              .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
              .join("\n") + "\n",
            { mode: 0o600, flag: "wx" }
          )
          start(d.id)
        } else if (d.status === "preparing") {
          if (!running(d.id) && existsSync(serviceFile(d.id))) start(d.id)
          if (d.heartbeatAt && Date.now() - Date.parse(d.heartbeatAt) > 90000) {
            await host("fail", d.id)
            stop(d.id)
          }
        } else if (d.status === "running") {
          if (!running(d.id) && existsSync(serviceFile(d.id))) start(d.id)
          const manifest = manifestSchema.parse(
            JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))
          )
          switchCurrent(root, manifest)
        }
      } catch {
        if (d.status === "queued" || d.status === "preparing")
          await host("fail", d.id).catch(() => {})
        console.error(
          JSON.stringify({
            event: "staging_installation_interrupted",
            deploymentId: d.id,
          })
        )
      }
    }
    if (process.argv.includes("--once")) break
    await delay()
  }
}
async function serviceLoop() {
  const id = z.uuid().parse(env.AGENTONIC_DEPLOYMENT_ID),
    secret = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(env.AGENTONIC_DEPLOYMENT_SECRET)
  const manifestPath = env.CREDENTIALS_DIRECTORY
    ? join(env.CREDENTIALS_DIRECTORY, "manifest")
    : env.AGENTONIC_MANIFEST_PATH!
  const raw = readFileSync(manifestPath, "utf8")
  const manifest = manifestSchema.parse(JSON.parse(raw))
  if (
    manifest.deploymentId !== id ||
    digest(raw) !== env.AGENTONIC_MANIFEST_HASH
  )
    throw new Error("Deployment manifest mismatch")
  verifyRuntime(manifest.runtime, runtimeRoot)
  // systemd supplies each generated asset as a private credential; local uses the immutable directory.
  for (const asset of manifest.assets) {
    const path = env.CREDENTIALS_DIRECTORY
      ? join(env.CREDENTIALS_DIRECTORY, digest(asset.path))
      : resolve(manifestPath, "..", asset.path)
    if (digest(readFileSync(path)) !== asset.sha256)
      throw new Error("Generated asset mismatch")
  }
  const service = async (operation: string) => {
    const r = await pool.query(
      "SELECT agentonic.deployment_service($1,$2,$3,$4) result",
      [
        operation,
        id,
        secret,
        JSON.stringify({ manifestHash: env.AGENTONIC_MANIFEST_HASH }),
      ]
    )
    if (!r.rows[0].result?.ok) throw new Error("Authorization unavailable")
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
  await service("ready")
  while (!stopping) {
    await service("heartbeat")
    const next = await pool.query(
      "SELECT agentonic.staging_worker('claim',$1,$2,NULL,NULL) result",
      [id, secret]
    )
    const job = next.rows[0].result as Lease | null
    if (!job) {
      await delay()
      continue
    }
    active = new AbortController()
    const controller = active
    const timer = setInterval(() => {
      void Promise.all([service("heartbeat"), execute("heartbeat", job)]).catch(
        () => controller.abort()
      )
    }, 20000)
    try {
      await processJob(
        job,
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
      await execute("fail", job, { code }).catch(() => {})
    } finally {
      clearInterval(timer)
      active = undefined
    }
  }
}
try {
  await (manager ? managerLoop() : serviceLoop())
} catch {
  console.error(
    JSON.stringify({
      event: manager ? "staging_installer_stopped" : "staging_runtime_stopped",
    })
  )
  process.exitCode = 1
} finally {
  for (const child of children.values()) child.kill("SIGTERM")
  await pool.end()
}
