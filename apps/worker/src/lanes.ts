// The knowledge worker's lanes (migration 43, architecture section 45). Each
// kind of work has its own slots, so a slow document never holds up a search or
// a preview turn. The worker asks only for lanes with a free slot; the database
// picks the job, sharing each lane fairly between workspaces.
import type { Lease } from "./pipeline"

export const LANES = [
  "purge",
  "ingest",
  "retrieve",
  "preview",
  "style",
  "action",
] as const
export type Lane = (typeof LANES)[number]
/** Lanes the database's knowledge claim serves; "style" (§57) and "action" (§58) have their own. */
export const KNOWLEDGE_LANES = [
  "purge",
  "ingest",
  "retrieve",
  "preview",
] as const
/** Jobs the worker runs at once in each lane. */
export const LANE_SLOTS: Readonly<Record<Lane, number>> = {
  purge: 1,
  ingest: 2,
  retrieve: 2,
  preview: 4,
  // Aprender mi estilo reads up to 200 messages; one run at a time is enough.
  style: 1,
  // A write a schedule pre-authorized (§58): one provider call each.
  action: 1,
}
export type LaneJob = Lease & { lane: Lane }

export type LaneLoop = {
  /** Lanes this worker serves: only cleanup when no embeddings provider is configured. */
  lanes: readonly Lane[]
  /** One job from the given lanes, or null when none is waiting. */
  claim(lanes: Lane[]): Promise<LaneJob | null>
  /** Runs one job to its end and records its outcome. */
  run(job: LaneJob, stop: AbortSignal): Promise<void>
  /** A claim failed; the loop waits `retryMs` before the next one. */
  unavailable(): void
  /** Stops claiming; running jobs see it too, and the loop returns once they end. */
  stop: AbortSignal
  /** Return once nothing is waiting and every claimed job has ended. */
  once?: boolean
  slots?: Readonly<Record<Lane, number>>
  idleMs?: number
  retryMs?: number
}

export async function serveLanes({
  lanes,
  claim,
  run,
  unavailable,
  stop,
  once = false,
  slots = LANE_SLOTS,
  idleMs = 1500,
  retryMs = 5000,
}: LaneLoop) {
  const busy = Object.fromEntries(LANES.map((lane) => [lane, 0])) as Record<
    Lane,
    number
  >
  const running = new Set<Promise<void>>()
  // A job that ends frees a slot: claim again at once, not after the wait.
  let wake = () => {}
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        stop.removeEventListener("abort", done)
        wake = () => {}
        resolve()
      }
      const timer = setTimeout(done, ms)
      wake = done
      if (stop.aborted) return done()
      stop.addEventListener("abort", done, { once: true })
    })
  while (!stop.aborted) {
    const free = lanes.filter((lane) => busy[lane] < slots[lane])
    if (free.length === 0) {
      await pause(idleMs)
      continue
    }
    let job: LaneJob | null
    try {
      job = await claim(free)
    } catch {
      unavailable()
      if (once) break
      await pause(retryMs)
      continue
    }
    if (!job) {
      if (once) break
      await pause(idleMs)
      continue
    }
    const lane = job.lane
    busy[lane]++
    const task: Promise<void> = run(job, stop)
      .catch(() => {})
      .finally(() => {
        busy[lane]--
        running.delete(task)
        wake()
      })
    running.add(task)
  }
  await Promise.all(running)
}
