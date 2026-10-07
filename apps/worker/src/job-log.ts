// One journal line per finished job (outstanding action A2, architecture
// §37.3): when it was queued, started and finished, the queue delay and run
// time, the outcome and an error category, with the job and deployment ids to
// correlate. Only these fields are ever written: never a query, an answer, a
// message body, an error message or a credential. Process liveness, dependency
// readiness and authorization stay in service-state.ts's waiting lines.

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE = /^[a-z][a-z_]{1,40}$/

export type FinishedJob = {
  /** Which worker ran it: knowledge, evaluation, preparation or staging_turn. */
  service: "knowledge" | "evaluation" | "preparation" | "staging_turn"
  job: { id: string; kind?: string; lane?: string; queuedAt?: string | null }
  deploymentId?: string
  startedAt: number
  finishedAt: number
  /** An error code such as `lease_lost`; anything else becomes "unexpected". */
  code?: string
}

const iso = (ms: number) => new Date(ms).toISOString()
const id = (value: string | undefined) =>
  value && ID.test(value) ? value : undefined

export function jobLine(entry: FinishedJob) {
  const queued = entry.job.queuedAt ? Date.parse(entry.job.queuedAt) : NaN
  const failed = entry.code !== undefined
  const line: Record<string, string | number> = {
    event: `${entry.service}_job_${failed ? "failed" : "completed"}`,
  }
  const set = (key: string, value: string | number | undefined) => {
    if (value !== undefined) line[key] = value
  }
  set("job", id(entry.job.id))
  set(
    "kind",
    entry.job.kind && CODE.test(entry.job.kind) ? entry.job.kind : undefined
  )
  set(
    "lane",
    entry.job.lane && CODE.test(entry.job.lane) ? entry.job.lane : undefined
  )
  set("deploymentId", id(entry.deploymentId))
  set("outcome", failed ? "failed" : "completed")
  if (failed) set("error", CODE.test(entry.code!) ? entry.code : "unexpected")
  if (Number.isFinite(queued)) {
    set("queuedAt", iso(queued))
    set("queueDelayMs", Math.max(0, entry.startedAt - queued))
  }
  set("startedAt", iso(entry.startedAt))
  set("finishedAt", iso(entry.finishedAt))
  set("durationMs", Math.max(0, entry.finishedAt - entry.startedAt))
  return line
}

export const logJob = (entry: FinishedJob, log = console.log) =>
  log(JSON.stringify(jobLine(entry)))
