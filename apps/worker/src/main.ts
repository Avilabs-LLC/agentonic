import { existsSync, readFileSync } from "node:fs"
import { parse } from "dotenv"
import pg from "pg"
import { workerFailure } from "./failure"
import { processJob, type Lease, type Execute } from "./pipeline"
import { directProviders, providerKeys } from "./providers"
import { storageSession } from "./storage-session"
const env = {
  ...(existsSync(new URL("../.env.local", import.meta.url))
    ? parse(readFileSync(new URL("../.env.local", import.meta.url)))
    : {}),
  ...process.env,
}
if (!env.DATABASE_URL || !env.AGENTONIC_DATABASE_CA_FILE || !env.SUPABASE_URL)
  throw new Error("Worker configuration required")
// The secret key bypasses every Storage and Auth rule; it belongs to bootstrap only.
if (env.SUPABASE_SECRET_KEY)
  throw new Error(
    "Remove SUPABASE_SECRET_KEY from the worker; run scripts/setup-storage-identity.mjs"
  )
const url = new URL(env.DATABASE_URL),
  supabase = new URL(env.SUPABASE_URL)
if (
  decodeURIComponent(url.username).split(".")[0] !== "agentonic_worker" ||
  supabase.protocol !== "https:" ||
  !supabase.hostname.endsWith(".supabase.co")
)
  throw new Error("Restricted worker configuration required")
const pool = new pg.Pool({
  host: url.hostname,
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: decodeURIComponent(url.pathname.slice(1)),
  ssl: {
    rejectUnauthorized: true,
    ca: readFileSync(env.AGENTONIC_DATABASE_CA_FILE, "utf8"),
  },
  max: 3,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
  application_name: "agentonic_knowledge_worker",
})
// pg removes failed idle connections itself. Handle its error event so the
// worker survives and the next poll can reconnect without logging credentials.
pool.on("error", () => {
  console.error(JSON.stringify({ event: "knowledge_worker_connection_lost" }))
})
// Storage through the worker's own account; it holds no Supabase secret key.
const config = {
  storage: storageSession(env),
  rerankEnabled: env.AGENTONIC_RERANK_ENABLED === "true",
  runtimeRoot: env.AGENTONIC_RUNTIME_ROOT,
  providers: directProviders(providerKeys(env)),
}
const execute: Execute = async (operation, job, payload = {}) => {
  const result = await pool.query(
    operation.startsWith("web-")
      ? "SELECT agentonic.web_preview_worker($1,$2::uuid,$3::uuid,$4::jsonb) result"
      : operation.startsWith("gmail-")
        ? "SELECT agentonic.gmail_preview_worker($1,$2::uuid,$3::uuid,$4::jsonb) result"
        : "SELECT agentonic.rag_worker($1,$2::uuid,$3::uuid,$4::jsonb) result",
    [operation, job.id, job.token, JSON.stringify(payload)]
  )
  return result.rows[0].result
}
let stopping = false,
  active: AbortController | undefined
process.once("SIGTERM", () => {
  stopping = true
  active?.abort()
})
process.once("SIGINT", () => {
  stopping = true
  active?.abort()
})
async function run() {
  console.log(
    JSON.stringify({
      event: "knowledge_worker_started",
      providerConfigured: config.providers.embeddings,
      storageConfigured: !!config.storage,
    })
  )
  try {
    while (!stopping) {
      try {
        const claimed = await pool.query(
          "SELECT agentonic.rag_claim($1) result",
          [!config.providers.embeddings]
        )
        const job = claimed.rows[0].result as Lease | null
        if (!job) {
          if (process.argv.includes("--once")) break
          await new Promise((r) => setTimeout(r, 1500))
          continue
        }
        active = new AbortController()
        const controller = active
        const signal = controller.signal
        const heartbeat = setInterval(() => {
          void execute("heartbeat", job).catch(() => controller.abort())
        }, 20000)
        try {
          await processJob(job, execute, config, signal)
          console.log(
            JSON.stringify({
              event: "knowledge_job_completed",
              job: job.id,
              kind: job.kind,
            })
          )
        } catch (error) {
          const { code, diagnostic } = workerFailure(error)
          await execute("fail", job, { code }).catch(() => {})
          console.log(
            JSON.stringify({
              event: "knowledge_job_stopped",
              job: job.id,
              kind: job.kind,
              code,
              diagnostic,
            })
          )
        } finally {
          clearInterval(heartbeat)
          active = undefined
        }
      } catch {
        console.error(JSON.stringify({ event: "knowledge_worker_unavailable" }))
        if (!process.argv.includes("--once"))
          await new Promise((r) => setTimeout(r, 5000))
      }
      if (process.argv.includes("--once")) break
    }
  } finally {
    await pool.end()
  }
}
void run()
