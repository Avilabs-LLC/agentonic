import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createConnection } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
  BUSY,
  GATEWAY_UNREACHABLE,
  GatewayClient,
  INVALID,
  MAX_LINE,
  PER_CONNECTION,
  REFUSED,
  codeOf,
  createGateway,
  parseRequest,
  type GatewayArgs,
} from "../apps/worker/src/gateway"
import { categorize } from "../apps/worker/src/service-state"

const deployment = "6f1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
const secret = "a".repeat(64)
const serviceArgs = (operation = "heartbeat"): GatewayArgs => [
  operation,
  deployment,
  secret,
  "{}",
]

describe("gateway requests", () => {
  it("maps each listed call to its fixed statement", () => {
    expect(
      parseRequest(
        JSON.stringify({
          id: 1,
          call: "deployment_service",
          args: serviceArgs(),
        })
      )
    ).toEqual({
      ok: true,
      id: 1,
      text: "SELECT agentonic.deployment_service($1,$2,$3,$4) result",
      values: serviceArgs(),
    })
    expect(
      parseRequest(
        JSON.stringify({
          id: 2,
          call: "gmail_staging",
          args: ["gmail-check", deployment, secret, null, null, "{}"],
        })
      )
    ).toMatchObject({
      ok: true,
      text: "SELECT agentonic.gmail_staging($1,$2,$3,$4,$5,$6) result",
    })
  })
  it("refuses anything else without reaching the database", () => {
    const parse = (value: unknown) =>
      parseRequest(typeof value === "string" ? value : JSON.stringify(value))
    // Unknown calls are refused; SQL is never taken from the copy.
    expect(
      parse({ id: 3, call: "deployment_host", args: serviceArgs() })
    ).toEqual({ ok: false, id: 3, error: REFUSED })
    expect(parse({ id: 4, call: "__proto__", args: serviceArgs() })).toEqual({
      ok: false,
      id: 4,
      error: REFUSED,
    })
    for (const args of [
      serviceArgs().slice(0, 3),
      ["heartbeat; DROP", deployment, secret, "{}"],
      ["heartbeat", "not-a-uuid", secret, "{}"],
      ["heartbeat", deployment, "short", "{}"],
      ["heartbeat", deployment, secret, 7],
    ])
      expect(parse({ id: 5, call: "deployment_service", args })).toEqual({
        ok: false,
        id: 5,
        error: INVALID,
      })
    expect(parse("not json")).toEqual({ ok: false, error: INVALID })
    expect(parse({ id: -1, call: "staging_worker", args: [] })).toEqual({
      ok: false,
      error: INVALID,
    })
  })
  it("returns codes, never messages, and keeps the copy's categories", () => {
    expect(codeOf({ code: "42501", message: "secret text" })).toBe("42501")
    expect(
      codeOf(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))
    ).toBe("ECONNREFUSED")
    expect(codeOf(new Error("Connection terminated unexpectedly"))).toBe(
      "ETIMEDOUT"
    )
    expect(codeOf(new Error("anything else"))).toBe("XX000")
    expect(codeOf({ code: "bad code; rm" })).toBe("XX000")
    expect(categorize({ code: GATEWAY_UNREACHABLE })).toBe(
      "gateway_unreachable"
    )
    expect(categorize({ code: BUSY })).toBe("database_busy")
  })
})

describe("gateway socket", () => {
  const cleanup: (() => void | Promise<void>)[] = []
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step()
  })
  async function serve(
    query: (text: string, values: GatewayArgs) => Promise<unknown>,
    path?: string
  ) {
    const dir = path ? undefined : mkdtempSync(join(tmpdir(), "gw-"))
    const socket = path ?? join(dir!, "gateway.sock")
    const report = { failed: [] as string[], succeeded: 0 }
    const server = createGateway(query, {
      failed: (code) => report.failed.push(code),
      succeeded: () => report.succeeded++,
    })
    await new Promise<void>((resolve) => server.listen(socket, resolve))
    cleanup.push(
      () =>
        new Promise<void>((resolve) => {
          server.shutdown()
          server.close(() => resolve())
          if (!server.listening) resolve()
        })
    )
    if (dir) cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    return { socket, server, report }
  }

  it("forwards a copy's calls and passes database refusals back as codes", async () => {
    const seen: [string, GatewayArgs][] = []
    const { socket, report } = await serve(async (text, values) => {
      seen.push([text, values])
      if (values[0] === "claim")
        throw Object.assign(new Error(`refused ${secret}`), { code: "42501" })
      return { ok: true }
    })
    const client = new GatewayClient(socket)
    cleanup.push(() => client.close())
    expect(await client.call("deployment_service", serviceArgs())).toEqual({
      ok: true,
    })
    await expect(
      client.call("staging_worker", [
        "claim",
        deployment,
        secret,
        null,
        null,
        "{}",
      ])
    ).rejects.toMatchObject({ code: "42501", message: "Gateway call failed" })
    expect(seen.map(([text]) => text)).toEqual([
      "SELECT agentonic.deployment_service($1,$2,$3,$4) result",
      "SELECT agentonic.staging_worker($1,$2,$3,$4,$5,$6) result",
    ])
    // A refusal is the copy's outcome, not a database problem.
    expect(report).toEqual({ failed: [], succeeded: 1 })
  })

  it("limits each copy's calls in flight and reports database outages", async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    const { socket, report } = await serve(async (_text, values) => {
      if (values[0] === "unreachable")
        throw Object.assign(new Error("down"), { code: "ECONNREFUSED" })
      await held
      return { ok: true }
    })
    const client = new GatewayClient(socket)
    cleanup.push(() => client.close())
    const waiting = Array.from({ length: PER_CONNECTION }, () =>
      client.call("deployment_service", serviceArgs())
    )
    await expect(
      client.call("deployment_service", serviceArgs())
    ).rejects.toMatchObject({ code: BUSY })
    // Another copy has its own allowance.
    const other = new GatewayClient(socket)
    cleanup.push(() => other.close())
    await expect(
      other.call("deployment_service", serviceArgs("unreachable"))
    ).rejects.toMatchObject({ code: "ECONNREFUSED" })
    release()
    expect(await Promise.all(waiting)).toHaveLength(PER_CONNECTION)
    expect(report.failed).toEqual(["ECONNREFUSED"])
  })

  it("closes a connection that sends an oversized line", async () => {
    const { socket } = await serve(async () => ({ ok: true }))
    const raw = createConnection(socket)
    const closed = new Promise<void>((resolve) =>
      raw.once("close", () => resolve())
    )
    raw.on("error", () => {})
    raw.write("x".repeat(MAX_LINE + 2))
    await closed
  })

  it("lets copies wait out a gateway restart and reconnect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-"))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, "gateway.sock")
    const first = await serve(async () => ({ generation: 1 }), path)
    const client = new GatewayClient(path)
    cleanup.push(() => client.close())
    expect(await client.call("deployment_service", serviceArgs())).toEqual({
      generation: 1,
    })
    await new Promise<void>((resolve) => {
      first.server.shutdown()
      first.server.close(() => resolve())
    })
    rmSync(path, { force: true })
    const failed = await client
      .call("deployment_service", serviceArgs())
      .catch((error: unknown) => error)
    expect(categorize(failed)).toBe("gateway_unreachable")
    await serve(async () => ({ generation: 2 }), path)
    expect(await client.call("deployment_service", serviceArgs())).toEqual({
      generation: 2,
    })
  })
})
