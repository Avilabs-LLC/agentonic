import { readFileSync, existsSync } from "node:fs"
import { parse } from "dotenv"
import { setTimeout as delay } from "node:timers/promises"
import pg from "pg"
import { runReviewCase } from "./evaluation-case"
import { prepareCriteria, gradeAnswer } from "./review-ai"
import { processJob, type Execute, type Lease } from "./pipeline"
import { directProviders } from "./providers"
import { FAST, ServiceState, categorize, reasonOf } from "./service-state"
const life = new ServiceState("evaluator")
// A configuration problem cannot fix itself: report it and exit so systemd's
// start limit turns it into a visible failed unit.
function configure() {
  try {
    const env = {
      ...(existsSync(new URL("../.env.evaluation.local", import.meta.url))
        ? parse(
            readFileSync(new URL("../.env.evaluation.local", import.meta.url))
          )
        : {}),
      ...process.env,
    }
    const url = new URL(env.DATABASE_URL ?? "")
    if (
      !env.AGENTONIC_RUNTIME_ROOT ||
      !env.AGENTONIC_EVALUATION_WORKER_SHA256 ||
      !["agentonic_eval_local", "agentonic_eval_azure"].includes(
        decodeURIComponent(url.username).split(".")[0] ?? ""
      )
    )
      throw new Error("configuration_invalid")
    const ca = readFileSync(env.AGENTONIC_DATABASE_CA_FILE ?? "", "utf8")
    return {
      env,
      url,
      ca,
      runtimeRoot: env.AGENTONIC_RUNTIME_ROOT,
      workerHash: env.AGENTONIC_EVALUATION_WORKER_SHA256,
    }
  } catch {
    life.stopped("configuration_invalid")
    process.exit(1)
  }
}
const { env, url, ca, runtimeRoot, workerHash } = configure()
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
const halt = new AbortController()
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, () => {
    stopping = true
    active?.abort()
    halt.abort()
  })
/** Waits, but returns at once when the service is asked to stop. */
const pause = (ms: number) =>
  delay(ms, undefined, { signal: halt.signal }).catch(() => {})
const openaiKey = env.OPENAI_API_KEY ?? ""
const config = {
  allowTools: false,
  providers: directProviders({
    openaiKey,
    voyageKey: env.VOYAGE_API_KEY ?? "",
  }),
  rerankEnabled: env.AGENTONIC_RERANK_ENABLED === "true",
  runtimeRoot,
}
async function run() {
  life.started({ worker: workerHash.slice(0, 12) })
  try {
    while (!stopping) {
      try {
        const result = await pool.query(
          "SELECT agentonic.evaluation_claim($1) result",
          [workerHash]
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
            [workerHash]
          )
          job = next.rows[0].result
          preparing = !!job
        }
        life.recovered()
        if (!job) {
          if (process.argv.includes("--once")) break
          await pause(2000)
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
              openaiKey,
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
              if (specification.reviewProtocol === 2)
                await runReviewCase(
                  job,
                  execute,
                  config,
                  (input, lease, call, signal) =>
                    gradeAnswer(input, lease, call, openaiKey, signal),
                  controller.signal
                )
              else await processJob(job, execute, config, controller.signal)
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
      } catch (error) {
        // A refused registration (expired, retired or revoked) waits for renewal instead of exiting.
        const refused = categorize(error) === "refused"
        const wait = life.waiting(
          refused ? "registration_refused" : reasonOf(error),
          refused ? FAST : undefined
        )
        if (process.argv.includes("--once")) break
        await pause(wait)
      }
      if (process.argv.includes("--once")) break
    }
  } finally {
    await pool.end()
  }
}
void run()
