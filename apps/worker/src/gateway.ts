// The database gateway: one process per staging host holds the database
// connections for every agent copy on it. Copies hold no database password.
// They send one of four fixed function calls over a local socket, each with
// their own deployment secret, and the database checks every call exactly as
// it did when copies connected directly. Connections therefore stay fixed
// however many agents a host runs.
//
// Protocol: one JSON object per line. A request is {id, call, args}; the reply
// is {id, result} or {id, error} where error is a database or network code,
// never message text. Requests and replies are never logged.
import { createConnection, createServer, type Socket } from "node:net"
import { z } from "zod"

/** The only calls a copy can make, with their number of arguments. */
export const GATEWAY_CALLS = {
  deployment_service: 4,
  staging_worker: 6,
  web_staging: 6,
  gmail_staging: 6,
} as const
export type GatewayCall = keyof typeof GATEWAY_CALLS
export type GatewayArgs = (string | null)[]
const statements = Object.fromEntries(
  Object.entries(GATEWAY_CALLS).map(([call, count]) => [
    call,
    `SELECT agentonic.${call}(${Array.from({ length: count }, (_, i) => `$${i + 1}`).join(",")}) result`,
  ])
) as Record<GatewayCall, string>

/** A request line longer than this closes the connection. */
export const MAX_LINE = 4 * 1024 * 1024
/** Calls one copy may have in flight; a copy makes at most three at once. */
export const PER_CONNECTION = 4
/** Calls waiting for a database connection before new ones are turned away as busy. */
export const MAX_WAITING = 256
/** Codes the gateway itself returns: a malformed request, an unknown call, too many calls. */
export const INVALID = "22023"
export const REFUSED = "42501"
export const BUSY = "53300"
/** The copy's side: the gateway could not be reached or dropped the connection. */
export const GATEWAY_UNREACHABLE = "EGATEWAY"

const request = z.object({
  id: z.number().int().nonnegative(),
  call: z.string(),
  args: z.array(z.string().nullable()),
})
const uuid = z.uuid()
const secret = /^[a-f0-9]{64}$/
const operation = /^[a-z][a-z-]{1,40}$/

/** Checks one request line. Copies cannot choose SQL, only a listed call and its values. */
export function parseRequest(
  line: string
):
  | { ok: true; id: number; text: string; values: GatewayArgs }
  | { ok: false; id?: number; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, error: INVALID }
  }
  const parsed = request.safeParse(raw)
  if (!parsed.success) {
    // Answer a readable id at once so the copy is not left waiting for a timeout.
    const id = request.shape.id.safeParse((raw as { id?: unknown } | null)?.id)
    return id.success
      ? { ok: false, id: id.data, error: INVALID }
      : { ok: false, error: INVALID }
  }
  const { id, call, args } = parsed.data
  if (!Object.hasOwn(GATEWAY_CALLS, call))
    return { ok: false, id, error: REFUSED }
  const known = call as GatewayCall
  if (
    args.length !== GATEWAY_CALLS[known] ||
    !operation.test(args[0] ?? "") ||
    !uuid.safeParse(args[1]).success ||
    !secret.test(args[2] ?? "")
  )
    return { ok: false, id, error: INVALID }
  return { ok: true, id, text: statements[known], values: args }
}

/** The error code a copy receives: a database code or a network code, never text. */
export function codeOf(error: unknown) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : ""
  // SQLSTATEs and Node network or TLS codes (ECONNREFUSED, CERT_HAS_EXPIRED).
  if (/^[0-9A-Z]{5}$/.test(code) || /^[A-Z][A-Z_]{2,40}$/.test(code))
    return code
  // node-postgres reports connection timeouts and dropped sockets without a code.
  if (error instanceof Error && /timeout|terminated/i.test(error.message))
    return "ETIMEDOUT"
  return "XX000"
}

export type GatewayQuery = (
  text: string,
  values: GatewayArgs
) => Promise<unknown>
export type GatewayReport = {
  /** A call failed for a reason other than the database refusing it. */
  failed(code: string): void
  succeeded(): void
}

/** Serves copies on a socket server; `waiting` reports calls queued for a database connection. */
export function createGateway(
  query: GatewayQuery,
  report: GatewayReport,
  waiting: () => number = () => 0
) {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    socket.on("error", () => socket.destroy())
    let buffer = ""
    let inFlight = 0
    const reply = (message: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n")
    }
    const handle = (line: string) => {
      const parsed = parseRequest(line)
      if (!parsed.ok)
        return reply({ id: parsed.id ?? null, error: parsed.error })
      if (inFlight >= PER_CONNECTION || waiting() >= MAX_WAITING)
        return reply({ id: parsed.id, error: BUSY })
      inFlight++
      query(parsed.text, parsed.values)
        .then(
          (result) => {
            report.succeeded()
            reply({ id: parsed.id, result })
          },
          (error: unknown) => {
            const code = codeOf(error)
            if (code !== REFUSED) report.failed(code)
            reply({ id: parsed.id, error: code })
          }
        )
        .finally(() => {
          inFlight--
        })
    }
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffer += chunk
      let end: number
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        if (line) handle(line)
      }
      if (buffer.length > MAX_LINE) socket.destroy()
    })
  })
  return Object.assign(server, {
    /** Stops accepting copies and closes the connections of those still attached. */
    shutdown() {
      server.close()
      for (const socket of sockets) socket.end()
    },
  })
}

type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}
const failure = (code: string) =>
  Object.assign(new Error("Gateway call failed"), { code })

/** A copy's connection to its host's gateway, opened on first use and reopened after a drop. */
export class GatewayClient {
  private socket: Socket | undefined
  private buffer = ""
  private next = 1
  private readonly pending = new Map<number, Pending>()
  constructor(
    private readonly path: string,
    private readonly timeoutMs = 40_000
  ) {}

  call(call: GatewayCall, args: GatewayArgs): Promise<unknown> {
    const socket = this.connect()
    const id = this.next++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(failure("ETIMEDOUT"))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      socket.write(JSON.stringify({ id, call, args }) + "\n")
    })
  }

  close() {
    this.socket?.destroy()
    this.socket = undefined
  }

  private connect() {
    if (this.socket) return this.socket
    const socket = createConnection(this.path)
    this.socket = socket
    this.buffer = ""
    socket.setEncoding("utf8")
    const drop = () => {
      if (this.socket === socket) this.socket = undefined
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer)
        entry.reject(failure(GATEWAY_UNREACHABLE))
        this.pending.delete(id)
      }
    }
    socket.on("error", () => socket.destroy())
    socket.once("close", drop)
    socket.on("data", (chunk: string) => {
      this.buffer += chunk
      let end: number
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        let reply: { id?: unknown; result?: unknown; error?: unknown }
        try {
          reply = JSON.parse(line)
        } catch {
          socket.destroy()
          return
        }
        const entry =
          typeof reply.id === "number" ? this.pending.get(reply.id) : undefined
        if (!entry) continue
        this.pending.delete(reply.id as number)
        clearTimeout(entry.timer)
        if (reply.error !== undefined)
          entry.reject(failure(String(reply.error)))
        else entry.resolve(reply.result ?? null)
      }
    })
    return socket
  }
}
