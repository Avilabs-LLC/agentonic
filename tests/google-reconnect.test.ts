import { afterEach, expect, it, vi } from "vitest"
import {
  GOOGLE_SCOPES,
  GOOGLE_TESTING,
  GoogleError,
  exchange,
  grantExpiry,
} from "../packages/connectors/src/google"
import { keyring } from "../packages/connectors/src/secrets"
import { googleGrantState } from "../packages/contracts/src/google-grant"
import { brokerFailure } from "../apps/worker/src/broker"
import { TurnFailure, workerFailure } from "../apps/worker/src/failure"
import { jobLine } from "../apps/worker/src/job-log"

// An expired Google authorization pauses the agent and ends the turn cleanly
// (architecture §84).
afterEach(() => {
  vi.unstubAllGlobals()
})
const now = Date.parse("2026-10-29T12:00:00.000Z")
const hour = 3600_000

it("ends a turn Google refused with its own reason, and keeps others as provider failures", () => {
  const refused = brokerFailure(new GoogleError("reconnect"))
  expect(refused).toBeInstanceOf(TurnFailure)
  expect(refused).toMatchObject({
    message: "google_reconnect",
    diagnostic: "google_reconnect",
  })
  expect(brokerFailure(new GoogleError("unavailable"))).toMatchObject({
    message: "provider_unavailable",
    diagnostic: "google_unavailable",
  })
  // Probar agente keeps the reason too.
  expect(
    workerFailure(new TurnFailure("google_reconnect", "google_reconnect"))
  ).toEqual({ code: "google_reconnect", diagnostic: "google_reconnect" })
})

it("says in the turn's log line when the database refused to record its failure", () => {
  const failed = {
    service: "staging_turn" as const,
    job: { id: "10000000-0000-4000-8000-000000000001", kind: "retrieve" },
    startedAt: now,
    finishedAt: now + 1000,
    code: "google_reconnect",
  }
  expect(jobLine({ ...failed, recordRefused: true })).toMatchObject({
    error: "google_reconnect",
    record: "refused",
  })
  expect(jobLine({ ...failed, recordRefused: false })).not.toHaveProperty(
    "record"
  )
})

it("dates a consent 7 days ahead while the app is in Testing, or earlier when Google says so", async () => {
  expect(GOOGLE_TESTING).toBe(true)
  expect(grantExpiry({}, now)).toBe(new Date(now + 168 * hour).toISOString())
  expect(grantExpiry({ refresh_token_expires_in: 3600 }, now)).toBe(
    new Date(now + hour).toISOString()
  )
  expect(grantExpiry({ refresh_token_expires_in: 30 * 24 * 3600 }, now)).toBe(
    new Date(now + 168 * hour).toISOString()
  )
  // The token response carries Google's lifetime through.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        access_token: "synthetic",
        expires_in: 3600,
        refresh_token: "synthetic",
        scope: GOOGLE_SCOPES[0],
        refresh_token_expires_in: 604799,
      })
    )
  )
  await expect(
    exchange(
      {
        clientId: "test",
        clientSecret: "test",
        redirectUri: "http://localhost:3101/api/connections/google/callback",
        keys: keyring("a".repeat(64)),
      },
      "code",
      "verifier"
    )
  ).resolves.toMatchObject({ refresh_token_expires_in: 604799 })
})

it("shows until when Google authorizes an account, warns the day before and asks to reconnect after", () => {
  const at = (offset: number) => new Date(now + offset).toISOString()
  expect(googleGrantState("connected", null, now)).toEqual({
    kind: "connected",
    text: "Cuenta conectada",
  })
  expect(googleGrantState("connected", at(3 * 24 * hour), now)).toMatchObject({
    kind: "connected",
    text: expect.stringMatching(/^Autorización de Google hasta el 1\/11\/2026/),
  })
  expect(googleGrantState("connected", at(5 * hour), now)).toMatchObject({
    kind: "soon",
    text: expect.stringContaining("para que el agente siga respondiendo"),
  })
  expect(googleGrantState("connected", at(-hour), now)).toMatchObject({
    kind: "reconnect",
    text: expect.stringMatching(/^La autorización de Google venció el/),
  })
  expect(googleGrantState("reconnect", at(3 * 24 * hour), now)).toEqual({
    kind: "reconnect",
    text: "Necesita volver a conectarse",
  })
})
