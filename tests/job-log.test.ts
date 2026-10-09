import { expect, it, vi } from "vitest"
import { jobLine, logJob } from "../apps/worker/src/job-log"

const job = "11111111-2222-4333-8444-555555555555"
const deployment = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const queued = Date.parse("2026-10-07T10:00:00Z")

it("records queue delay, duration, outcome and correlation ids", () => {
  expect(
    jobLine({
      service: "staging_turn",
      job: {
        id: job,
        kind: "retrieve",
        queuedAt: new Date(queued).toISOString(),
      },
      deploymentId: deployment,
      startedAt: queued + 1500,
      finishedAt: queued + 4000,
    })
  ).toEqual({
    event: "staging_turn_job_completed",
    job,
    kind: "retrieve",
    deploymentId: deployment,
    outcome: "completed",
    queuedAt: "2026-10-07T10:00:00.000Z",
    queueDelayMs: 1500,
    startedAt: "2026-10-07T10:00:01.500Z",
    finishedAt: "2026-10-07T10:00:04.000Z",
    durationMs: 2500,
  })
})

it("writes only allowlisted fields: never content, messages or credentials", () => {
  const log = vi.fn()
  const secret = "sk-live-1234567890"
  logJob(
    {
      service: "knowledge",
      job: {
        id: job,
        kind: "ingest",
        lane: "ingest",
        queuedAt: null,
        // Fields a lease or a careless caller might carry.
        ...({
          token: secret,
          query: "¿Cuál es el saldo de mi cuenta?",
        } as object),
      },
      startedAt: queued,
      finishedAt: queued + 10,
      code: `Error: password=${secret} for mail "Hola Ana"`,
    },
    log
  )
  const line = JSON.parse(log.mock.calls[0]![0] as string)
  expect(Object.keys(line).sort()).toEqual(
    [
      "durationMs",
      "error",
      "event",
      "finishedAt",
      "job",
      "kind",
      "lane",
      "outcome",
      "startedAt",
    ].sort()
  )
  expect(line).toMatchObject({
    event: "knowledge_job_failed",
    outcome: "failed",
    error: "unexpected",
  })
  const text = log.mock.calls[0]![0] as string
  for (const content of [secret, "saldo", "Hola Ana", "password"])
    expect(text).not.toContain(content)
})

it("drops malformed ids and kinds instead of logging them", () => {
  expect(
    jobLine({
      service: "evaluation",
      job: { id: "not-a-uuid; DROP", kind: "Retrieve Now!" },
      deploymentId: "x",
      startedAt: queued,
      finishedAt: queued,
      code: "lease_lost",
    })
  ).toEqual({
    event: "evaluation_job_failed",
    outcome: "failed",
    error: "lease_lost",
    startedAt: "2026-10-07T10:00:00.000Z",
    finishedAt: "2026-10-07T10:00:00.000Z",
    durationMs: 0,
  })
})

it("counts what a style run skipped and names Gmail's status class only", () => {
  const style = {
    service: "knowledge" as const,
    job: { id: job, kind: "style", lane: "style" },
    startedAt: queued,
    finishedAt: queued + 30000,
  }
  expect(jobLine({ ...style, skipped: 2 })).toMatchObject({
    event: "knowledge_job_completed",
    skipped: 2,
  })
  expect(jobLine({ ...style, skipped: 0 })).not.toHaveProperty("skipped")
  expect(
    jobLine({ ...style, skipped: "2; Hola Ana" as unknown as number })
  ).not.toHaveProperty("skipped")
  expect(jobLine({ ...style, code: "gmail_http_503" })).toMatchObject({
    error: "gmail_http_503",
  })
  // A rate limit names its kind and the wait Gmail asked for, never its message.
  expect(
    jobLine({
      ...style,
      limited: "gmail_http_403_user_rate_limit",
      limitWaitMs: 20000,
    })
  ).toMatchObject({
    limited: "gmail_http_403_user_rate_limit",
    limitWaitMs: 20000,
  })
  const careless = jobLine({
    ...style,
    limited: "User-rate limit exceeded. Retry after 2026-10-09T11:45:00Z",
    limitWaitMs: Number.NaN,
  })
  expect(careless).not.toHaveProperty("limited")
  expect(careless).not.toHaveProperty("limitWaitMs")
})
