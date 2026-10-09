// Scheduled retention sweeps the knowledge worker runs between jobs
// (outstanding action B3). Each logs counts only, never content.
export const RETENTION_INTERVAL_MS = 15 * 60_000

type Query = (sql: string) => Promise<{ rows: { result: unknown }[] }>

export async function sweepGmail(query: Query, log = console.log) {
  try {
    const result = (
      await query("SELECT agentonic.gmail_retention_sweep() result")
    ).rows[0]?.result as Record<string, number> | undefined
    if (result && Object.values(result).some((n) => n > 0))
      log(JSON.stringify({ event: "gmail_retention_swept", ...result }))
    return result
  } catch {
    log(JSON.stringify({ event: "gmail_retention_sweep_failed" }))
    return undefined
  }
}

/** The same sweep for Drive proposals and OAuth states (migration 65). */
export async function sweepDrive(query: Query, log = console.log) {
  try {
    const result = (
      await query("SELECT agentonic.drive_retention_sweep() result")
    ).rows[0]?.result as Record<string, number> | undefined
    if (result && Object.values(result).some((n) => n > 0))
      log(JSON.stringify({ event: "drive_retention_swept", ...result }))
    return result
  } catch {
    log(JSON.stringify({ event: "drive_retention_sweep_failed" }))
    return undefined
  }
}

/** Runs the sweeps now and then on an interval until `stop` aborts. */
export function scheduleRetention(
  query: Query,
  stop: AbortSignal,
  interval = RETENTION_INTERVAL_MS
) {
  const sweep = () => void sweepGmail(query).then(() => sweepDrive(query))
  sweep()
  const timer = setInterval(sweep, interval)
  stop.addEventListener("abort", () => clearInterval(timer), { once: true })
  return timer
}
