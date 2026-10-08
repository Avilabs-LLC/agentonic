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

/** Runs the sweep now and then on an interval until `stop` aborts. */
export function scheduleRetention(
  query: Query,
  stop: AbortSignal,
  interval = RETENTION_INTERVAL_MS
) {
  void sweepGmail(query)
  const timer = setInterval(() => void sweepGmail(query), interval)
  stop.addEventListener("abort", () => clearInterval(timer), { once: true })
  return timer
}
