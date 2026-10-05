import { expect, it } from "vitest"
import {
  FAST,
  Incidents,
  SLOW,
  ServiceState,
  backoff,
  categorize,
  reasonOf,
} from "../apps/worker/src/service-state"

const coded = (code: string) => Object.assign(new Error("hidden"), { code })

it("categorizes database and network errors by code, never by message content", () => {
  expect(categorize(coded("42501"))).toBe("refused")
  expect(categorize(coded("ECONNREFUSED"))).toBe("database_unreachable")
  expect(categorize(coded("08006"))).toBe("database_unreachable")
  expect(categorize(coded("53300"))).toBe("database_busy")
  expect(categorize(coded("57014"))).toBe("database_busy")
  expect(categorize(coded("23505"))).toBe("database_error")
  expect(
    categorize(new Error("Connection terminated due to connection timeout"))
  ).toBe("database_unreachable")
  expect(categorize(new Error("Customer text that must not leak"))).toBe(
    "unexpected"
  )
  // Our own codes pass through; free text never does.
  expect(reasonOf(new Error("runtime_mismatch"))).toBe("runtime_mismatch")
  expect(reasonOf(new Error("Some message with spaces"))).toBe("unexpected")
})

it("backs off exponentially up to a ceiling", () => {
  expect([1, 2, 3, 4, 5].map((n) => backoff(n, FAST))).toEqual([
    5000, 10000, 20000, 30000, 30000,
  ])
  expect(backoff(10, SLOW)).toBe(60000)
})

it("logs a failing subject once per state, reminds while it persists and reports recovery", () => {
  let now = 0
  const lines: Record<string, unknown>[] = []
  const incidents = new Incidents(
    "deployment",
    { host: "h" },
    { log: (line) => lines.push(line), now: () => now, reminderMs: 600_000 }
  )
  expect(incidents.due("d1")).toBe(true)
  expect(incidents.fail("d1", "service_start_failed", { step: "start" })).toBe(
    5000
  )
  expect(incidents.due("d1")).toBe(false)
  now = 5000
  expect(incidents.due("d1")).toBe(true)
  incidents.fail("d1", "service_start_failed")
  incidents.fail("d1", "service_start_failed")
  expect(lines).toHaveLength(1)
  expect(lines[0]).toEqual({
    event: "deployment_waiting",
    host: "h",
    step: "start",
    reason: "service_start_failed",
    since: new Date(0).toISOString(),
    attempts: 1,
    retryInSeconds: 5,
  })
  // A different reason starts a new incident; a long one is repeated.
  incidents.fail("d1", "refused")
  now += 600_000
  incidents.fail("d1", "refused")
  expect(lines.map((line) => [line.reason, line.attempts])).toEqual([
    ["service_start_failed", 1],
    ["refused", 1],
    ["refused", 2],
  ])
  incidents.ok("d1")
  incidents.ok("d1")
  expect(lines.at(-1)).toMatchObject({
    event: "deployment_recovered",
    reason: "refused",
    waitedSeconds: 600,
  })
  expect(lines).toHaveLength(4)
})

it("writes service lines with the event first so the journal can be searched", () => {
  const lines: string[] = []
  const state = new ServiceState(
    "deployment-controller",
    { broker: "abc" },
    { log: (line) => lines.push(JSON.stringify(line)), now: () => 0 }
  )
  state.started()
  expect(state.waiting("registration_refused", FAST)).toBe(5000)
  state.recovered()
  state.stopped("configuration_invalid")
  expect(lines.map((line) => line.slice(0, 26))).toEqual([
    '{"event":"service_started"',
    '{"event":"service_waiting"',
    '{"event":"service_recovere',
    '{"event":"service_stopped"',
  ])
  expect(JSON.parse(lines[1]!)).toMatchObject({
    service: "deployment-controller",
    broker: "abc",
    reason: "registration_refused",
  })
})
