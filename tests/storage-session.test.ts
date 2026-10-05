import { afterEach, expect, it, vi } from "vitest"
import {
  StorageSession,
  storageSession,
} from "../apps/worker/src/storage-session"

afterEach(() => vi.unstubAllGlobals())
const signal = new AbortController().signal

it("signs in as the worker's account and reuses the token until shortly before it expires", async () => {
  let clock = 0
  const fetch = vi.fn(async () =>
    Response.json({
      access_token: `token-${fetch.mock.calls.length}`,
      expires_in: 3600,
    })
  )
  vi.stubGlobal("fetch", fetch)
  const session = new StorageSession(
    "https://example.supabase.co",
    "sb_publishable_x",
    "storage-worker@example.invalid",
    "synthetic-password",
    () => clock
  )
  expect(await session.headers(signal)).toEqual({
    apikey: "sb_publishable_x",
    Authorization: "Bearer token-1",
  })
  clock = 3_400_000
  expect((await session.headers(signal)).Authorization).toBe("Bearer token-1")
  expect(fetch).toHaveBeenCalledTimes(1)
  clock = 3_480_000
  expect((await session.headers(signal)).Authorization).toBe("Bearer token-2")
  const [url, init] = fetch.mock.calls[0]! as unknown as [string, RequestInit]
  expect(url).toBe(
    "https://example.supabase.co/auth/v1/token?grant_type=password"
  )
  expect(init.headers).toEqual({
    apikey: "sb_publishable_x",
    "Content-Type": "application/json",
  })
})

it("reports a refused or unreachable sign-in as storage_unavailable", async () => {
  const session = () =>
    new StorageSession("https://example.supabase.co", "k", "e@x.invalid", "p")
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 })
    )
  )
  await expect(session().headers(signal)).rejects.toThrow("storage_unavailable")
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")))
  await expect(session().headers(signal)).rejects.toThrow("storage_unavailable")
})

it("needs the complete account configuration", () => {
  const env = {
    SUPABASE_URL: "https://example.supabase.co/",
    SUPABASE_PUBLISHABLE_KEY: "k",
    AGENTONIC_STORAGE_EMAIL: "e@x.invalid",
    AGENTONIC_STORAGE_PASSWORD: "p",
  }
  expect(storageSession(env)?.url).toBe("https://example.supabase.co")
  expect(
    storageSession({ ...env, AGENTONIC_STORAGE_PASSWORD: "" })
  ).toBeUndefined()
})
