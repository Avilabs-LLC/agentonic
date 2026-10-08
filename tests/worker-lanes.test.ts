import { expect, it, vi } from "vitest"
import {
  LANE_SLOTS,
  serveLanes,
  type Lane,
  type LaneJob,
} from "../apps/worker/src/lanes"

// The knowledge worker's lanes: each kind of work has its own slots, so a slow
// document never holds up a search or a preview turn.
const kinds = {
  purge: "purge",
  ingest: "ingest",
  retrieve: "retrieve",
  preview: "retrieve",
  style: "style",
} as const
let next = 0
const job = (lane: Lane): LaneJob => ({
  id: `job-${++next}`,
  token: "token",
  kind: kinds[lane],
  lane,
})
/** A queue that hands out the first waiting job in any free lane, like the claim. */
function queue(...jobs: LaneJob[]) {
  const waiting = [...jobs]
  const asked: Lane[][] = []
  return {
    asked,
    waiting,
    claim: vi.fn(async (lanes: Lane[]) => {
      asked.push(lanes)
      const index = waiting.findIndex((j) => lanes.includes(j.lane))
      return index < 0 ? null : waiting.splice(index, 1)[0]!
    }),
  }
}
/** Jobs that run until the test ends them, or until the worker stops. */
function jobs() {
  const running = new Map<string, () => void>()
  const done: string[] = []
  return {
    running,
    done,
    run: (j: LaneJob, stop: AbortSignal) =>
      new Promise<void>((resolve) => {
        const end = () => {
          running.delete(j.id)
          done.push(j.id)
          resolve()
        }
        running.set(j.id, end)
        stop.addEventListener("abort", end, { once: true })
      }),
    end(id: string) {
      running.get(id)?.()
    },
  }
}
const settle = () => new Promise((r) => setTimeout(r, 5))

it("serves preview turns while a slow document is still processing", async () => {
  const slow = job("ingest")
  const turns = [job("preview"), job("preview"), job("preview")]
  const q = queue(slow, ...turns)
  const work = jobs()
  const stop = new AbortController()
  const loop = serveLanes({
    lanes: ["purge", "ingest", "retrieve", "preview"],
    claim: q.claim,
    run: work.run,
    unavailable: () => {},
    stop: stop.signal,
    idleMs: 1,
  })
  await settle()
  expect(work.running.has(slow.id)).toBe(true)
  for (const turn of turns) {
    expect(work.running.has(turn.id)).toBe(true)
    work.end(turn.id)
  }
  await settle()
  expect(work.done).toEqual(turns.map((t) => t.id))
  // The document is still processing the whole time.
  expect(work.running.has(slow.id)).toBe(true)
  stop.abort()
  await loop
  expect(work.done).toContain(slow.id)
})

it("runs at most a lane's slots at once and asks only for lanes with a free slot", async () => {
  const previews = Array.from({ length: LANE_SLOTS.preview + 2 }, () =>
    job("preview")
  )
  const q = queue(...previews)
  const work = jobs()
  const stop = new AbortController()
  const loop = serveLanes({
    lanes: ["ingest", "preview"],
    claim: q.claim,
    run: work.run,
    unavailable: () => {},
    stop: stop.signal,
    // Far longer than the test: only a freed slot can start the next turn.
    idleMs: 60_000,
  })
  await settle()
  expect(work.running.size).toBe(LANE_SLOTS.preview)
  expect(q.waiting).toHaveLength(2)
  expect(q.asked.at(-1)).toEqual(["ingest"])
  // A turn that ends frees its slot for the next one at once.
  work.end(previews[0]!.id)
  await settle()
  expect(work.running.has(previews[LANE_SLOTS.preview]!.id)).toBe(true)
  expect(work.running.size).toBe(LANE_SLOTS.preview)
  stop.abort()
  await loop
  expect(work.running.size).toBe(0)
})

it("asks only for cleanup when that is all the worker serves", async () => {
  const q = queue(job("ingest"), job("purge"))
  const work = jobs()
  await serveLanes({
    lanes: ["purge"],
    claim: q.claim,
    run: async (j) => void work.done.push(j.id),
    unavailable: () => {},
    stop: new AbortController().signal,
    once: true,
  })
  expect(q.asked.every((lanes) => lanes.join() === "purge")).toBe(true)
  expect(work.done).toHaveLength(1)
  expect(q.waiting.map((j) => j.lane)).toEqual(["ingest"])
})

it("waits after a failed claim, then claims again", async () => {
  const unavailable = vi.fn()
  const claim = vi
    .fn<(lanes: Lane[]) => Promise<LaneJob | null>>()
    .mockRejectedValueOnce(Object.assign(new Error("down"), { code: "57P01" }))
    .mockResolvedValue(null)
  const stop = new AbortController()
  const loop = serveLanes({
    lanes: ["purge"],
    claim,
    run: async () => {},
    unavailable,
    stop: stop.signal,
    retryMs: 40,
    idleMs: 1,
  })
  await settle()
  expect(unavailable).toHaveBeenCalledTimes(1)
  expect(claim).toHaveBeenCalledTimes(1)
  await new Promise((r) => setTimeout(r, 60))
  expect(claim.mock.calls.length).toBeGreaterThan(1)
  stop.abort()
  await loop
})

it("returns in once mode after the queue empties and every job has ended", async () => {
  const q = queue(job("ingest"), job("retrieve"), job("preview"))
  const ended: string[] = []
  await serveLanes({
    lanes: ["purge", "ingest", "retrieve", "preview"],
    claim: q.claim,
    run: async (j) => {
      await new Promise((r) => setTimeout(r, 10))
      ended.push(j.lane)
    },
    unavailable: () => {},
    stop: new AbortController().signal,
    once: true,
  })
  expect(ended.sort()).toEqual(["ingest", "preview", "retrieve"])
})

it("stops at once while idle", async () => {
  const stop = new AbortController()
  const loop = serveLanes({
    lanes: ["purge"],
    claim: async () => null,
    run: async () => {},
    unavailable: () => {},
    stop: stop.signal,
    idleMs: 60_000,
  })
  await settle()
  stop.abort()
  await expect(
    Promise.race([
      loop.then(() => "stopped"),
      new Promise((r) => setTimeout(() => r("waiting"), 500)),
    ])
  ).resolves.toBe("stopped")
})
