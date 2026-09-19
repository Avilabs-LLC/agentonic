import { readFileSync, existsSync } from "node:fs"
import { parse } from "dotenv"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import { prepareCriteria, gradeAnswer } from "./review-ai"
import { processJob, type Execute, type Lease } from "./pipeline"
const env = {
  ...(existsSync(new URL("../.env.evaluation.local", import.meta.url))
    ? parse(readFileSync(new URL("../.env.evaluation.local", import.meta.url)))
    : {}),
  ...process.env,
}
if (
  !env.DATABASE_URL ||
  !env.AGENTONIC_DATABASE_CA_FILE ||
  !env.AGENTONIC_RUNTIME_ROOT ||
  !env.AGENTONIC_EVALUATION_WORKER_SHA256
)
  throw new Error("Evaluation configuration required")
const url = new URL(env.DATABASE_URL)
if (
  !["agentonic_eval_local", "agentonic_eval_azure"].includes(
    decodeURIComponent(url.username).split(".")[0] ?? ""
  )
)
  throw new Error("Evaluation-only database role required")
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
  max: 2,
  connectionTimeoutMillis: 10000,
  statement_timeout: 30000,
  application_name: "agentonic_evaluator",
})
const execute: Execute = async (operation, job, payload = {}) => {
  const result = await pool.query(
    "SELECT agentonic.evaluation_worker($1,$2,$3,$4) result",
    [operation, job.id, job.token, JSON.stringify(payload)]
  )
  return result.rows[0].result
}
const prepareExecute: Execute = async (operation, job, payload = {}) => {
  const result = await pool.query(
    "SELECT agentonic.review_preparation_worker($1,$2,$3,$4) result",
    [operation, job.id, job.token, JSON.stringify(payload)]
  )
  return result.rows[0].result
}
let stopping = false
let active: AbortController | undefined
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopping = true
    active?.abort()
  })
const config = {
  allowTools: false,
  supabaseUrl: "",
  storageKey: "",
  voyageKey: env.VOYAGE_API_KEY ?? "",
  rerankEnabled: env.AGENTONIC_RERANK_ENABLED === "true",
  openaiKey: env.OPENAI_API_KEY ?? "",
  runtimeRoot: env.AGENTONIC_RUNTIME_ROOT,
}
async function run() {
  console.log(JSON.stringify({ event: "evaluation_worker_started" }))
  try {
    while (!stopping) {
      try {
        const result = await pool.query(
          "SELECT agentonic.evaluation_claim($1) result",
          [env.AGENTONIC_EVALUATION_WORKER_SHA256]
        )
        let job = result.rows[0].result as
          (Lease & { caseCount: number }) | null
        let preparing = false
        if (
          !job &&
          decodeURIComponent(url.username).split(".")[0] ===
            "agentonic_eval_azure"
        ) {
          const next = await pool.query(
            "SELECT agentonic.review_preparation_claim($1) result",
            [env.AGENTONIC_EVALUATION_WORKER_SHA256]
          )
          job = next.rows[0].result
          preparing = !!job
        }
        if (!job) {
          if (process.argv.includes("--once")) break
          await new Promise((r) => setTimeout(r, 2000))
          continue
        }
        active = new AbortController()
        const controller = active
        const broker = preparing ? prepareExecute : execute
        const heartbeat = setInterval(() => {
          void broker("heartbeat", job!).catch(() => controller.abort())
        }, 20000)
        try {
          if (preparing) {
            const context = await broker("read", job)
            const criteria = await prepareCriteria(
              context,
              job,
              broker,
              config.openaiKey,
              controller.signal
            )
            await broker("prepared", job, criteria)
          } else
            for (let i = 0; i < job.caseCount; i++) {
              if (controller.signal.aborted) throw new Error("lease_lost")
              // Development provider accounts have low per-minute quotas. Do not
              // retry a paid case after an unknown outcome; pace independent cases.
              if (i > 0)
                await delay(31000, undefined, { signal: controller.signal })
              const specification = await execute("read", job)
              if (specification.reviewProtocol === 2) {
                let answer: Record<string, unknown> | undefined
                const capture: Execute = async (operation, lease, payload) => {
                  if (operation === "answer") {
                    answer = payload
                    return { ok: true }
                  }
                  return execute(operation, lease, payload)
                }
                await processJob(job, capture, config, controller.signal)
                if (!answer) throw new Error("provider_unavailable")
                const context = await execute("grade-context", job)
                const assessment = await gradeAnswer(
                  { context, answer },
                  job,
                  execute,
                  config.openaiKey,
                  controller.signal
                )
                await execute("answer", job, { ...answer, assessment })
              } else await processJob(job, execute, config, controller.signal)
            }
          console.log(
            JSON.stringify({
              event: "evaluation_finished",
              evaluationId: job.id,
            })
          )
        } catch (error) {
          const code =
            error instanceof Error &&
            [
              "budget_exhausted",
              "configuration_required",
              "provider_unavailable",
              "runtime_mismatch",
            ].includes(error.message)
              ? error.message
              : "lease_lost"
          await broker("fail", job, { code }).catch(() => {})
          console.log(
            JSON.stringify({
              event: "evaluation_interrupted",
              evaluationId: job.id,
              code,
            })
          )
        } finally {
          clearInterval(heartbeat)
          active = undefined
        }
      } catch {
        console.error(
          JSON.stringify({ event: "evaluation_worker_unavailable" })
        )
        if (process.argv.includes("--once")) break
        await new Promise((r) => setTimeout(r, 5000))
      }
      if (process.argv.includes("--once")) break
    }
  } finally {
    await pool.end()
  }
}
void run()
