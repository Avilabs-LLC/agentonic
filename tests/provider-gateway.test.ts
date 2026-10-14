import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  BUSY,
  GatewayClient,
  INVALID,
  PROVIDER_PER_CONNECTION,
  createGateway,
  type GatewayArgs,
} from "../apps/worker/src/gateway"
import {
  directProviders,
  gatewayCapabilities,
  gatewayProviders,
  gatewaySend,
  providerGateway,
  type ModelCall,
  type Providers,
} from "../apps/worker/src/providers"
import { categorize } from "../apps/worker/src/service-state"
import { GoogleError } from "../packages/connectors/src/google"
import { keyring, seal } from "../packages/connectors/src/secrets"
import type { Execute, Lease } from "../apps/worker/src/pipeline"

const deployment = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const secret = "c".repeat(64)
const job: Lease = {
  id: "10000000-0000-4000-8000-000000000001",
  token: "10000000-0000-4000-8000-000000000002",
  kind: "retrieve",
}
const HOST_KEY = "sk-host-only-synthetic"
const call: ModelCall = {
  model: "gpt-4.1-mini-2025-04-14",
  reasoning: null,
  input: [{ role: "user", content: "Synthetic" }],
  format: { type: "json_schema", name: "x", strict: true, schema: {} },
  timeoutMs: 5000,
}
const completed = {
  status: "completed",
  usage: { input_tokens: 12, output_tokens: 3 },
  output: [{ type: "message", content: [{ type: "output_text", text: "{}" }] }],
}

type Sql = { text: string; values: GatewayArgs }
const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  for (const step of cleanup.splice(0).reverse()) await step()
})

/** A real gateway socket with the real provider handler; `database` answers its fixed statements. */
async function host(
  providers: Providers,
  database: (sql: Sql) => unknown = () => ({ ok: true })
) {
  const sql: Sql[] = []
  const query = async (text: string, values: GatewayArgs) => {
    sql.push({ text, values })
    return database({ text, values })
  }
  const dir = mkdtempSync(join(tmpdir(), "pg-"))
  const socket = join(dir, "gateway.sock")
  const server = createGateway(
    query,
    { failed: () => {}, succeeded: () => {} },
    () => 0,
    providerGateway(providers, query)
  )
  await new Promise<void>((resolve) => server.listen(socket, resolve))
  const client = new GatewayClient(socket)
  cleanup.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () =>
      new Promise<void>((resolve) => {
        server.shutdown()
        server.close(() => resolve())
      }),
    () => client.close()
  )
  const send = gatewaySend(client, deployment, secret)
  // The copy holds no key: it learns from the gateway what the host can do.
  const copy = gatewayProviders(send, await gatewayCapabilities(send))
  return { copy, client, sql }
}
const operations = (sql: Sql[]) => sql.map(({ values }) => values[0])
/** The copy's own execute is never used for provider work. */
const unused = vi.fn<Execute>()

describe("agent copies call providers through the gateway", () => {
  it("runs a model call with the host's key and the copy's own credentials", async () => {
    const fetch = vi.fn(async () => Response.json(completed))
    vi.stubGlobal("fetch", fetch)
    const { copy, sql } = await host(directProviders({ openaiKey: HOST_KEY }))
    expect(copy).toMatchObject({ models: true, embeddings: false, web: false })
    const outcome = await copy.respond(
      call,
      job,
      unused,
      new AbortController().signal
    )
    expect(outcome).toEqual({
      kind: "response",
      status: "completed",
      output: completed.output,
    })
    // Reserve, report, send once, settle: each with this copy's deployment,
    // secret and lease, so the database authorizes it as the copy.
    expect(operations(sql)).toEqual(["reserve", "heartbeat", "settle"])
    for (const { text, values } of sql) {
      expect(text).toBe(
        "SELECT agentonic.staging_worker($1,$2,$3,$4,$5,$6) result"
      )
      expect(values.slice(1, 5)).toEqual([
        deployment,
        secret,
        job.id,
        job.token,
      ])
    }
    const init = fetch.mock.calls[0]! as unknown as [string, RequestInit]
    expect(init[0]).toBe("https://api.openai.com/v1/responses")
    expect(new Headers(init[1].headers).get("authorization")).toBe(
      `Bearer ${HOST_KEY}`
    )
    // The reservation is the gateway's own: the copy never sees its ID, so it
    // cannot settle it with a different usage.
    const reserved = JSON.parse(sql[0]!.values[5]!) as { id: string }
    const settled = JSON.parse(sql[2]!.values[5]!) as { id: string }
    expect(settled.id).toBe(reserved.id)
    expect(JSON.stringify(outcome)).not.toContain(reserved.id)
    expect(unused).not.toHaveBeenCalled()
  })

  it("fixes model controls itself and refuses anything the copy adds", async () => {
    const fetch = vi.fn(async () => Response.json(completed))
    vi.stubGlobal("fetch", fetch)
    const { copy, client, sql } = await host(
      directProviders({ openaiKey: HOST_KEY })
    )
    await copy.respond(
      { ...call, model: "gpt-6-astra", reasoning: "high" },
      job,
      unused,
      new AbortController().signal
    )
    const body = JSON.parse(
      (fetch.mock.calls[0]! as unknown as [string, RequestInit])[1]
        .body as string
    )
    expect(body).toMatchObject({
      model: "gpt-6-astra",
      store: false,
      reasoning: { effort: "high" },
      max_output_tokens: 16384,
    })
    // A raw request with its own provider controls never reaches the database or OpenAI.
    const raw = (payload: unknown, jobId: string | null = job.id) =>
      client.call("provider", [
        "respond",
        deployment,
        secret,
        jobId,
        jobId && job.token,
        JSON.stringify(payload),
      ])
    sql.length = 0
    fetch.mockClear()
    expect(await raw({ ...call, max_output_tokens: 100000 })).toEqual({
      ok: false,
      failure: "runtime_mismatch",
    })
    expect(await raw({ ...call, model: "gpt-unknown" })).toEqual({
      ok: false,
      failure: "runtime_mismatch",
    })
    expect(await raw({ ...call, reasoning: "high" })).toEqual({
      ok: false,
      failure: "runtime_mismatch",
    })
    // Provider work always names a lease.
    expect(await raw(call, null)).toEqual({
      ok: false,
      failure: "runtime_mismatch",
    })
    await expect(
      client.call("provider", [
        "respond",
        deployment,
        secret,
        job.id,
        null,
        "{}",
      ])
    ).rejects.toMatchObject({ code: INVALID })
    await expect(
      client.call("provider", [
        "respond",
        deployment,
        secret,
        job.id,
        job.token,
        "not json",
      ])
    ).rejects.toMatchObject({ code: INVALID })
    expect(sql).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it("passes refused budgets, unknown outcomes and database refusals back unchanged", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    let reserve: unknown = { ok: false }
    const { copy, sql } = await host(
      directProviders({ openaiKey: HOST_KEY }),
      ({ values }) => {
        if (values[0] !== "reserve") return { ok: true }
        if (reserve instanceof Error) throw reserve
        return reserve
      }
    )
    const settled = () =>
      sql
        .filter(({ values }) => values[0] === "settle")
        .map(({ values }) => JSON.parse(String(values.at(-1))))
    const signal = new AbortController().signal
    expect(await copy.respond(call, job, unused, signal)).toEqual({
      kind: "budget",
    })
    expect(fetch).not.toHaveBeenCalled()
    reserve = { ok: true }
    fetch.mockRejectedValueOnce(new Error("synthetic transport failure"))
    expect(await copy.respond(call, job, unused, signal)).toEqual({
      kind: "uncertain",
    })
    fetch.mockResolvedValueOnce(new Response("{}", { status: 500 }))
    await expect(copy.respond(call, job, unused, signal)).rejects.toThrow(
      "provider_unavailable"
    )
    // A server error may have been billed: its reservation stays (§66).
    expect(settled()).toEqual([])
    // A refusal (no credit, a rate limit) billed nothing: released at zero (§78).
    fetch.mockResolvedValueOnce(
      new Response('{"error":{"code":"insufficient_quota"}}', { status: 429 })
    )
    await expect(copy.respond(call, job, unused, signal)).rejects.toThrow(
      "provider_unavailable"
    )
    expect(settled()).toMatchObject([
      { microusd: 0, tokens: 0, outputTokens: 0 },
    ])
    // An expired secret or lost lease is the database's answer, as before.
    reserve = Object.assign(new Error("permission denied"), { code: "42501" })
    const refused = await copy
      .respond(call, job, unused, signal)
      .catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: "42501" })
    expect(categorize(refused)).toBe("refused")
  })

  it("opens Gmail tokens only at the gateway and returns the same failures", async () => {
    const keys = keyring("a".repeat(64))
    const connectionId = "30000000-0000-4000-8000-000000000001"
    const fetch = vi.fn(async () => new Response("{}", { status: 400 }))
    vi.stubGlobal("fetch", fetch)
    const { copy, sql } = await host(
      directProviders({
        google: {
          clientId: "test",
          clientSecret: "host-only-client-secret",
          redirectUri: "http://localhost",
          keys,
        },
      }),
      ({ values }) =>
        values[0] === "gmail-read"
          ? {
              credential: seal(
                { refreshToken: "synthetic" },
                `gmail:${connectionId}`,
                keys
              ),
              account: "synthetic@example.invalid",
            }
          : { ok: true }
    )
    expect(copy.gmail).toBe(true)
    const failed = await copy
      .gmailTool(
        "gmail.search",
        { query: "x", limit: 1 },
        { connectionId, operations: ["gmail.search"] },
        job,
        unused
      )
      .catch((error: unknown) => error)
    // Google refused the refresh: the copy sees the same error a direct call throws.
    expect(failed).toBeInstanceOf(GoogleError)
    expect(failed).toMatchObject({ code: "reconnect" })
    expect(operations(sql)).toEqual(["gmail-read", "gmail-reconnect"])
    expect(sql[0]!.text).toBe(
      "SELECT agentonic.gmail_staging($1,$2,$3,$4,$5,$6) result"
    )
    const body = String(
      (fetch.mock.calls[0]! as unknown as [string, RequestInit])[1].body
    )
    expect(body).toContain("host-only-client-secret")
  })

  it("stops a provider call at the gateway when the copy loses its lease", async () => {
    let seen: AbortSignal | undefined
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            seen = init.signal!
            init.signal!.addEventListener("abort", () =>
              reject(new Error("aborted"))
            )
          })
      )
    )
    const { copy } = await host(directProviders({ openaiKey: HOST_KEY }))
    const lease = new AbortController()
    const pending = copy.respond(call, job, unused, lease.signal)
    await vi.waitFor(() => expect(seen).toBeDefined())
    lease.abort()
    await expect(pending).rejects.toThrow("lease_lost")
    await vi.waitFor(() => expect(seen!.aborted).toBe(true))
  })

  it("limits each copy's provider calls in flight", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    )
    const { client } = await host(directProviders({ openaiKey: HOST_KEY }))
    const args = (): GatewayArgs => [
      "respond",
      deployment,
      secret,
      job.id,
      job.token,
      JSON.stringify(call),
    ]
    const held = Array.from({ length: PROVIDER_PER_CONNECTION }, () =>
      client.call("provider", args()).catch(() => undefined)
    )
    await expect(client.call("provider", args())).rejects.toMatchObject({
      code: BUSY,
    })
    client.close()
    await Promise.all(held)
  })

  it("refuses work the host has no key for before sending anything", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const { copy, sql } = await host(directProviders({}))
    expect(copy).toMatchObject({
      models: false,
      embeddings: false,
      web: false,
      gmail: false,
    })
    await expect(
      copy.respond(call, job, unused, new AbortController().signal)
    ).rejects.toThrow("configuration_required")
    await expect(
      copy.embed(["x"], "query", job, unused, new AbortController().signal)
    ).rejects.toThrow("configuration_required")
    expect(sql).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })
})
