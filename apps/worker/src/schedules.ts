// Scheduled jobs (architecture §58), the knowledge worker's part: a tick that
// queues due runs, and the "action" lane that executes a write a schedule
// pre-authorized, exactly as the customer app does after a person confirms:
// arguments checked against their hash, one provider call, never retried.
import { z } from "zod"
import { parseGmailCall, gmailArguments } from "@agentonic/contracts/gmail"
import {
  gmail,
  refresh,
  GoogleError,
  type GoogleConfig,
} from "@agentonic/connectors/google"
import { digest, unseal } from "@agentonic/connectors/secrets"
import type { Lease } from "./pipeline"

export const TICK_INTERVAL_MS = 30_000
type Query = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: { result: unknown }[] }>

/** Queues due runs; logs counts only. */
export async function tickSchedules(query: Query, log = console.log) {
  try {
    const result = (await query("SELECT agentonic.schedule_tick() result"))
      .rows[0]?.result as { queued: number; skipped: number } | undefined
    if (result && (result.queued || result.skipped))
      log(JSON.stringify({ event: "schedules_ticked", ...result }))
    return result
  } catch {
    log(JSON.stringify({ event: "schedules_tick_failed" }))
    return undefined
  }
}
/**
 * Renews running deployments in their last three days while nothing changed
 * (§59), or records what stops them; logs counts only.
 */
export async function tickRenewals(query: Query, log = console.log) {
  try {
    const result = (
      await query("SELECT agentonic.deployment_renewal_tick() result")
    ).rows[0]?.result as { renewed: number; blocked: number } | undefined
    if (result && (result.renewed || result.blocked))
      log(JSON.stringify({ event: "deployments_renewed", ...result }))
    return result
  } catch {
    log(JSON.stringify({ event: "deployments_renewal_failed" }))
    return undefined
  }
}
/** Ticks now and then on an interval until `stop` aborts. */
export function scheduleTicks(
  query: Query,
  stop: AbortSignal,
  interval = TICK_INTERVAL_MS
) {
  const tick = async () => {
    await tickRenewals(query)
    await tickSchedules(query)
  }
  void tick()
  const timer = setInterval(() => void tick(), interval)
  stop.addEventListener("abort", () => clearInterval(timer), { once: true })
  return timer
}

export const scheduledAction = z.object({
  id: z.uuid(),
  token: z.uuid(),
  kind: z.literal("action"),
  lane: z.literal("action"),
  queuedAt: z.string().nullable().optional(),
  connectionId: z.uuid(),
  credential: z.string(),
  account: z.string(),
  operation: z.string(),
  argumentsCiphertext: z.string(),
  hash: z.string(),
})
export type ScheduledAction = z.infer<typeof scheduledAction> & Lease

/** Executes one claimed write and records its outcome; never repeats it. */
export async function runScheduledAction(
  job: ScheduledAction,
  complete: (outcome: string, detail: Record<string, unknown>) => Promise<void>,
  google: GoogleConfig
) {
  let outcome = "failed",
    detail: Record<string, unknown> = { code: "failed" }
  try {
    const args = unseal(
      job.argumentsCiphertext,
      `invocation:${job.id}`,
      google.keys
    )
    const call = parseGmailCall(job.operation, args)
    if (digest(JSON.stringify(call.arguments)) !== job.hash) {
      detail = { code: "arguments_changed" }
      return
    }
    const secret = z
      .object({ refreshToken: z.string() })
      .parse(unseal(job.credential, `gmail:${job.connectionId}`, google.keys))
    let access: string
    try {
      access = await refresh(google, secret.refreshToken)
    } catch (error) {
      // No mailbox change was attempted.
      detail = {
        code:
          error instanceof GoogleError && error.code === "reconnect"
            ? "reconnect"
            : "unavailable",
      }
      return
    }
    try {
      detail = (await gmail(
        access,
        call.operation,
        gmailArguments[call.operation].parse(args),
        job.account,
        job.id
      )) as Record<string, unknown>
      outcome = "succeeded"
    } catch (error) {
      outcome =
        error instanceof GoogleError && error.code !== "uncertain"
          ? "failed"
          : "uncertain"
      detail = { code: outcome }
    }
  } finally {
    await complete(outcome, detail)
  }
}
