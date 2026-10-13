import { afterEach, expect, it, vi } from "vitest"
import { digest, keyring, seal } from "../packages/connectors/src/secrets"
import {
  runScheduledAction,
  tickRenewals,
  tickSchedules,
  type ScheduledAction,
} from "../apps/worker/src/schedules"
import {
  PROPOSAL_ANSWER,
  SCHEDULED_ACTION_ANSWER,
  proposalAnswer,
} from "../apps/worker/src/broker"
import {
  cadenceDescription,
  scheduleForm,
} from "../packages/contracts/src/schedules"
// Scheduled jobs (architecture §58): the worker's tick and action lane.
afterEach(() => vi.unstubAllGlobals())
const keys = keyring("d".repeat(64))
const google = {
  clientId: "client",
  clientSecret: "secret",
  redirectUri: "https://example.invalid/api/connections/google/callback",
  keys,
}
const id = "10000000-0000-4000-8000-000000000001"
const message = {
  to: ["ana@example.invalid"],
  cc: [],
  bcc: [],
  subject: "Resumen",
  body: "Hola Ana, aquí va el resumen.",
}
const job = (args: unknown = message): ScheduledAction => ({
  id,
  token: "10000000-0000-4000-8000-000000000002",
  kind: "action",
  lane: "action",
  connectionId: "10000000-0000-4000-8000-000000000003",
  credential: seal(
    { refreshToken: "refresh" },
    "gmail:10000000-0000-4000-8000-000000000003",
    keys
  ),
  account: "nico@example.invalid",
  operation: "gmail.send",
  argumentsCiphertext: seal(args, `invocation:${id}`, keys),
  hash: digest(JSON.stringify(message)),
})

it("sends a pre-authorized write once, with its exact arguments, and records the outcome", async () => {
  const calls: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url))
      return String(url).includes("oauth2")
        ? Response.json({ access_token: "access", expires_in: 3600 })
        : Response.json({ id: "sent-1", threadId: "t1" })
    })
  )
  const complete = vi.fn(async () => {})
  await runScheduledAction(job(), complete, google)
  expect(calls.filter((u) => u.includes("messages/send"))).toHaveLength(1)
  expect(complete).toHaveBeenCalledWith("succeeded", {
    id: "sent-1",
    threadId: "t1",
  })
})

it("never sends changed arguments, and records an uncertain send without retrying", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  const complete = vi.fn(async () => {})
  await runScheduledAction(
    job({ ...message, to: ["otra@example.invalid"] }),
    complete,
    google
  )
  expect(fetch).not.toHaveBeenCalled()
  expect(complete).toHaveBeenCalledWith("failed", {
    code: "arguments_changed",
  })
  const send = vi.fn(async (url: string) =>
    String(url).includes("oauth2")
      ? Response.json({ access_token: "access", expires_in: 3600 })
      : new Response("{}", { status: 503 })
  )
  vi.stubGlobal("fetch", send)
  const second = vi.fn(async () => {})
  await runScheduledAction(job(), second, google)
  expect(
    send.mock.calls.filter(([u]) => String(u).includes("messages/send"))
  ).toHaveLength(1)
  expect(second).toHaveBeenCalledWith("uncertain", { code: "uncertain" })
})

it("asks to reconnect without touching the mailbox when Google refuses the token", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 400 }))
  )
  const complete = vi.fn(async () => {})
  await runScheduledAction(job(), complete, google)
  expect(complete).toHaveBeenCalledWith("failed", { code: "reconnect" })
})

it("logs only counts from the tick, and survives a failed tick", async () => {
  const log = vi.fn()
  await tickSchedules(
    async () => ({ rows: [{ result: { queued: 2, skipped: 1 } }] }),
    log
  )
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({ event: "schedules_ticked", queued: 2, skipped: 1 })
  )
  await tickSchedules(async () => {
    throw new Error("connection lost")
  }, log)
  expect(log).toHaveBeenLastCalledWith(
    JSON.stringify({ event: "schedules_tick_failed" })
  )
})

it("says when the schedule's authorization will run a proposed write", () => {
  expect(proposalAnswer({ pendingApproval: true, automatic: true })).toBe(
    SCHEDULED_ACTION_ANSWER
  )
  expect(proposalAnswer({ pendingApproval: true, automatic: false })).toBe(
    PROPOSAL_ANSWER
  )
  expect(proposalAnswer(undefined)).toBe(PROPOSAL_ANSWER)
})

it("validates a schedule form and describes its cadence in Spanish", () => {
  const base = {
    name: "Resumen",
    instruction: "Resume mi correo.",
    cadence: "weekly",
    timeOfDay: "18:30",
    weekday: 6,
    everyHours: null,
    timezone: "Europe/Madrid",
    model: "gpt-6-luna",
    reasoning: "medium",
    autonomy: [],
    consent: false,
  }
  expect(scheduleForm.safeParse(base).success).toBe(true)
  expect(cadenceDescription(scheduleForm.parse(base))).toBe(
    "Los sábados a las 18:30"
  )
  expect(
    scheduleForm.safeParse({ ...base, autonomy: ["gmail.send"] }).success
  ).toBe(false)
  expect(
    scheduleForm.safeParse({ ...base, autonomy: ["gmail.send"], consent: true })
      .success
  ).toBe(true)
  expect(
    scheduleForm.safeParse({
      ...base,
      model: "gpt-4.1-mini-2025-04-14",
      reasoning: null,
    }).success
  ).toBe(false)
  expect(scheduleForm.safeParse({ ...base, weekday: null }).success).toBe(false)
  expect(
    cadenceDescription({
      cadence: "hours",
      timeOfDay: "08:00",
      weekday: null,
      everyHours: 6,
    })
  ).toBe("Cada 6 h desde las 08:00")
})

it("logs only counts from the renewal tick (§59)", async () => {
  const log = vi.fn()
  await tickRenewals(
    async () => ({ rows: [{ result: { renewed: 1, blocked: 2 } }] }),
    log
  )
  expect(log).toHaveBeenCalledWith(
    JSON.stringify({ event: "deployments_renewed", renewed: 1, blocked: 2 })
  )
  await tickRenewals(
    async () => ({ rows: [{ result: { renewed: 0, blocked: 0 } }] }),
    log
  )
  expect(log).toHaveBeenCalledTimes(1)
})
