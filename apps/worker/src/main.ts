import { existsSync, readFileSync } from "node:fs"
import { parse } from "dotenv"
import pg from "pg"
import { z } from "zod"
import { workerFailure } from "./failure"
import { KNOWLEDGE_LANES, LANES, serveLanes, type LaneJob } from "./lanes"
import { logJob } from "./job-log"
import { parsePdf, processJob, type Execute } from "./pipeline"
import { scheduleRetention } from "./retention"
import { directProviders, providerKeys } from "./providers"
import { storageSession } from "./storage-session"
import {
  runStyleGuide,
  StyleFailure,
  StyleStopped,
  type StyleJob,
} from "./style-guide"
import {
  runScheduledAction,
  scheduledAction,
  scheduleTicks,
  type ScheduledAction,
} from "./schedules"
import {
  runScheduledDriveAction,
  scheduledDriveAction,
  syncDriveFile,
  type ScheduledDriveAction,
} from "./drive"
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
  // Two lanes' document publishes can hold a connection for seconds each.
  max: 4,
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
const keys = providerKeys(env)
const config = {
  storage: storageSession(env),
  rerankEnabled: env.AGENTONIC_RERANK_ENABLED === "true",
  runtimeRoot: env.AGENTONIC_RUNTIME_ROOT,
  providers: directProviders(keys),
}
const execute: Execute = async (operation, job, payload = {}) => {
  const result = await pool.query(
    operation.startsWith("web-")
      ? "SELECT agentonic.web_preview_worker($1,$2::uuid,$3::uuid,$4::jsonb) result"
      : operation.startsWith("gmail-")
        ? "SELECT agentonic.gmail_preview_worker($1,$2::uuid,$3::uuid,$4::jsonb) result"
        : operation.startsWith("drive-")
          ? "SELECT agentonic.drive_preview_worker($1,$2::uuid,$3::uuid,$4::jsonb) result"
          : "SELECT agentonic.rag_worker($1,$2::uuid,$3::uuid,$4::jsonb) result",
    [operation, job.id, job.token, JSON.stringify(payload)]
  )
  return result.rows[0].result
}
// A Drive knowledge sync has its own steps; its spend goes through the
// ordinary job ledger (migration 65).
const driveExecute: Execute = async (operation, job, payload = {}) =>
  (
    await pool.query(
      "SELECT agentonic.drive_sync_worker($1,$2::uuid,$3::uuid,$4::jsonb) result",
      [operation, job.id, job.token, JSON.stringify(payload)]
    )
  ).rows[0].result
// Aprender mi estilo has its own functions, lease and budget (migration 61).
const styleExecute: Execute = async (operation, job, payload = {}) =>
  (
    await pool.query(
      "SELECT agentonic.style_guide_worker($1,$2::uuid,$3::uuid,$4::jsonb) result",
      [operation, job.id, job.token, JSON.stringify(payload)]
    )
  ).rows[0].result
const styleClaimed = z
  .object({
    id: z.uuid(),
    token: z.uuid(),
    kind: z.literal("style"),
    lane: z.literal("style"),
    queuedAt: z.string().nullable().optional(),
    connectionId: z.uuid(),
    windowDays: z.number().int(),
    maxMessages: z.number().int(),
  })
  .nullable()
const STYLE_FAILURES = [
  "configuration_required",
  "gmail_unavailable",
  "not_enough_mail",
  "budget_exhausted",
  "provider_unavailable",
]
const stop = new AbortController()
process.once("SIGTERM", () => stop.abort())
process.once("SIGINT", () => stop.abort())
const claimed = z
  .object({
    id: z.uuid(),
    token: z.uuid(),
    kind: z.enum(["ingest", "purge", "retrieve", "drive_sync"]),
    lane: z.enum(LANES),
    queuedAt: z.string().nullable().optional(),
  })
  .nullable()
async function runStyle(job: StyleJob & LaneJob, stopping: AbortSignal) {
  const lost = new AbortController()
  const signal = AbortSignal.any([stopping, lost.signal])
  const heartbeat = setInterval(() => {
    void styleExecute("heartbeat", job).catch(() => lost.abort())
  }, 20000)
  const startedAt = Date.now()
  try {
    const reading = await runStyleGuide(
      job,
      styleExecute,
      { google: keys.google, openaiKey: keys.openaiKey },
      signal
    )
    logJob({
      service: "knowledge",
      job,
      startedAt,
      finishedAt: Date.now(),
      ...reading,
    })
  } catch (error) {
    // Codes only: a failure never carries message text.
    const code =
      error instanceof Error && STYLE_FAILURES.includes(error.message)
        ? error.message
        : "lease_lost"
    if (!(error instanceof StyleStopped))
      await styleExecute("fail", job, { code }).catch(() => {})
    logJob({
      service: "knowledge",
      job,
      startedAt,
      finishedAt: Date.now(),
      code:
        error instanceof StyleStopped
          ? "reconnect"
          : error instanceof StyleFailure
            ? error.diagnostic
            : code,
    })
  } finally {
    clearInterval(heartbeat)
  }
}
async function runAction(
  job: (ScheduledAction | ScheduledDriveAction) & LaneJob
) {
  const startedAt = Date.now()
  let failed: string | undefined
  const complete =
    (fn: string) =>
    async (outcome: string, detail: Record<string, unknown>) => {
      if (outcome !== "succeeded") failed = String(detail.code ?? outcome)
      await pool.query(`SELECT agentonic.${fn}($1::uuid,$2,$3::jsonb) result`, [
        job.id,
        outcome,
        JSON.stringify(detail),
      ])
    }
  await (
    "provider" in job && job.provider === "drive"
      ? runScheduledDriveAction(
          job as ScheduledDriveAction,
          complete("drive_action_complete"),
          keys.google!
        )
      : runScheduledAction(
          job as ScheduledAction,
          complete("schedule_action_complete"),
          keys.google!
        )
  ).catch(() => {
    failed = "lease_lost"
  })
  logJob({
    service: "knowledge",
    job,
    startedAt,
    finishedAt: Date.now(),
    code: failed,
  })
}
async function run(job: LaneJob, stopping: AbortSignal) {
  if (job.lane === "style") return runStyle(job as StyleJob & LaneJob, stopping)
  if (job.lane === "action")
    return runAction(job as (ScheduledAction | ScheduledDriveAction) & LaneJob)
  const steps = job.kind === "drive_sync" ? driveExecute : execute
  const lost = new AbortController()
  const signal = AbortSignal.any([stopping, lost.signal])
  const heartbeat = setInterval(() => {
    void steps("heartbeat", job).catch(() => lost.abort())
  }, 20000)
  const startedAt = Date.now()
  try {
    if (job.kind === "drive_sync")
      await syncDriveFile(
        job,
        driveExecute,
        keys.google,
        config.providers.embed,
        parsePdf,
        signal
      )
    else await processJob(job, execute, config, signal)
    logJob({ service: "knowledge", job, startedAt, finishedAt: Date.now() })
  } catch (error) {
    const { code, diagnostic } = workerFailure(error)
    await steps("fail", job, { code }).catch(() => {})
    logJob({
      service: "knowledge",
      job,
      startedAt,
      finishedAt: Date.now(),
      code: diagnostic,
    })
  } finally {
    clearInterval(heartbeat)
  }
}
async function main() {
  // Without an embeddings provider only cleanup can run.
  const lanes = config.providers.embeddings ? LANES : (["purge"] as const)
  console.log(
    JSON.stringify({
      event: "knowledge_worker_started",
      providerConfigured: config.providers.embeddings,
      storageConfigured: !!config.storage,
      lanes,
    })
  )
  if (!process.argv.includes("--once")) {
    scheduleRetention((sql) => pool.query(sql), stop.signal)
    // Due schedules queue their runs (§58); deployments wake for them.
    scheduleTicks((sql, params) => pool.query(sql, params), stop.signal)
  }
  try {
    await serveLanes({
      lanes,
      claim: async (free) => {
        const knowledge = free.filter((lane) =>
          (KNOWLEDGE_LANES as readonly string[]).includes(lane)
        )
        const job = knowledge.length
          ? claimed.parse(
              (
                await pool.query(
                  "SELECT agentonic.knowledge_claim($1) result",
                  [knowledge]
                )
              ).rows[0].result
            )
          : null
        if (job || !keys.google) return job
        // A pre-authorized write waits seconds at most; it goes before a guide.
        if (free.includes("action")) {
          const action = (
            await pool.query("SELECT agentonic.schedule_action_claim() result")
          ).rows[0].result
          if (action) return scheduledAction.parse(action)
          const drive = (
            await pool.query("SELECT agentonic.drive_action_claim() result")
          ).rows[0].result
          if (drive) return scheduledDriveAction.parse(drive)
        }
        if (!free.includes("style")) return null
        return styleClaimed.parse(
          (await pool.query("SELECT agentonic.style_guide_claim() result"))
            .rows[0].result
        )
      },
      run,
      unavailable: () =>
        console.error(
          JSON.stringify({ event: "knowledge_worker_unavailable" })
        ),
      stop: stop.signal,
      once: process.argv.includes("--once"),
    })
  } finally {
    await pool.end()
  }
}
void main()
