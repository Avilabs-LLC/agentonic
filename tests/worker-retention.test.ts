import { afterEach, expect, it, vi } from "vitest"
import { scheduleRetention, sweepGmail } from "../apps/worker/src/retention"

afterEach(() => vi.useRealTimers())

it("logs only counts, and only when the sweep changed something", async () => {
  const log = vi.fn()
  const query = vi.fn(async () => ({
    rows: [{ result: { expired: 2, uncertain: 0, oauthStates: 1 } }],
  }))
  expect(await sweepGmail(query, log)).toEqual({
    expired: 2,
    uncertain: 0,
    oauthStates: 1,
  })
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({
      event: "gmail_retention_swept",
      expired: 2,
      uncertain: 0,
      oauthStates: 1,
    })
  )
  log.mockClear()
  await sweepGmail(
    async () => ({ rows: [{ result: { expired: 0, uncertain: 0 } }] }),
    log
  )
  expect(log).not.toHaveBeenCalled()
})

it("survives a failed sweep without logging its error text", async () => {
  const log = vi.fn()
  await sweepGmail(async () => {
    throw new Error("password=secret")
  }, log)
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({ event: "gmail_retention_sweep_failed" })
  )
  expect(JSON.stringify(log.mock.calls)).not.toContain("secret")
})

it("sweeps Gmail and Drive at start and every interval until stopped", async () => {
  vi.useFakeTimers()
  const query = vi.fn<(sql: string) => Promise<{ rows: { result: unknown }[] }>>(
    async () => ({ rows: [{ result: {} }] })
  )
  const stop = new AbortController()
  scheduleRetention(query, stop.signal, 1000)
  await vi.advanceTimersByTimeAsync(0)
  expect(query).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(2500)
  expect(query.mock.calls.map(([sql]) => sql)).toEqual(
    Array.from({ length: 3 }, () => [
      "SELECT agentonic.gmail_retention_sweep() result",
      "SELECT agentonic.drive_retention_sweep() result",
    ]).flat()
  )
  stop.abort()
  await vi.advanceTimersByTimeAsync(5000)
  expect(query).toHaveBeenCalledTimes(6)
})
