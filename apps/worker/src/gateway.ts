// The host gateway: one process per staging host holds the database
// connections and the provider keys for every agent copy on it. Copies hold
// neither. They send one of five fixed database calls, or a provider call,
// over a local socket, each with their own deployment secret. The database
// checks every call exactly as it did when copies connected directly, and the
// gateway makes provider calls with that copy's credentials (providers.ts).
// Connections and keys therefore stay fixed however many agents a host runs.
//
// Protocol: one JSON object per line. A request is {id, call, args}; the reply
// is {id, result} or {id, error} where error is a database or network code,
// never message text. {cancel: id} stops a provider call the copy no longer
// needs. Requests and replies are never logged.
import { createConnection, createServer, type Socket } from "node:net"
import { z } from "zod"

/** The database calls a copy can make, with their number of arguments. */
export const DATABASE_CALLS = {
  deployment_service: 4,
  staging_worker: 6,
  web_staging: 6,
  gmail_staging: 6,
  drive_staging: 6,
} as const
/** Every call a copy can make: the database calls and provider calls (operation, deployment, secret, job, token, payload). */
export const GATEWAY_CALLS = { ...DATABASE_CALLS, provider: 6 } as const
export type GatewayCall = keyof typeof GATEWAY_CALLS
export type DatabaseCall = keyof typeof DATABASE_CALLS
export type GatewayArgs = (string | null)[]
export const statements = Object.fromEntries(
  Object.entries(DATABASE_CALLS).map(([call, count]) => [
    call,
    `SELECT agentonic.${call}(${Array.from({ length: count }, (_, i) => `$${i + 1}`).join(",")}) result`,
  ])
) as Record<DatabaseCall, string>
/** The database call that carries one job operation. */
export const jobCall = (operation: string): DatabaseCall =>
  operation.startsWith("web-")
    ? "web_staging"
    : operation.startsWith("gmail-")
      ? "gmail_staging"
      : operation.startsWith("drive-")
        ? "drive_staging"
        : "staging_worker"

/** A request line longer than this closes the connection. */
export const MAX_LINE = 4 * 1024 * 1024
/** Database calls one copy may have in flight; a copy makes at most three at once. */
export const PER_CONNECTION = 4
/** Provider calls one copy may have in flight; a copy's turn makes one at a time. */
export const PROVIDER_PER_CONNECTION = 2
/** Provider calls in flight across the host before new ones are turned away as busy. */
export const MAX_PROVIDER_CALLS = 64
/** Calls waiting for a database connection before new ones are turned away as busy. */
export const MAX_WAITING = 256
/** A reply line longer than this closes the copy's connection. */
export const MAX_REPLY = 16 * 1024 * 1024
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
const cancel = z.object({ cancel: z.number().int().nonnegative() }).strict()
const uuid = z.uuid()
const secret = /^[a-f0-9]{64}$/
const operation = /^[a-z][a-z-]{1,40}$/

/** Checks one request line. Copies cannot choose SQL, only a listed call and its values. */
export function parseRequest(
  line: string
):
  | { ok: true; id: number; call: GatewayCall; values: GatewayArgs }
  | { ok: true; cancel: number }
  | { ok: false; id?: number; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return { ok: false, error: INVALID }
  }
  const stop = cancel.safeParse(raw)
  if (stop.success) return { ok: true, cancel: stop.data.cancel }
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
  return { ok: true, id, call: known, values: args }
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
/** Runs one provider call (its six arguments); a host without provider keys passes none. */
export type GatewayProvider = (
  args: GatewayArgs,
  signal: AbortSignal
) => Promise<unknown>

/** Serves copies on a socket server; `waiting` reports calls queued for a database connection. */
export function createGateway(
  query: GatewayQuery,
  report: GatewayReport,
  waiting: () => number = () => 0,
  provider?: GatewayProvider
) {
  const sockets = new Set<Socket>()
  let providerCalls = 0
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => socket.destroy())
    let buffer = ""
    let inFlight = 0
    // A provider call stops when its copy cancels it or goes away.
    const running = new Map<number, AbortController>()
    socket.once("close", () => {
      sockets.delete(socket)
      for (const controller of running.values()) controller.abort()
    })
    const reply = (message: Record<string, unknown>) => {
      if (!socket.destroyed) socket.write(JSON.stringify(message) + "\n")
    }
    const settle = (id: number, work: Promise<unknown>) =>
      work.then(
        (result) => {
          report.succeeded()
          reply({ id, result })
        },
        (error: unknown) => {
          const code = codeOf(error)
          if (code !== REFUSED) report.failed(code)
          reply({ id, error: code })
        }
      )
    const handle = (line: string) => {
      const parsed = parseRequest(line)
      if (!parsed.ok)
        return reply({ id: parsed.id ?? null, error: parsed.error })
      if ("cancel" in parsed) return running.get(parsed.cancel)?.abort()
      const { id, call, values } = parsed
      if (call === "provider") {
        if (!provider) return reply({ id, error: REFUSED })
        if (
          running.size >= PROVIDER_PER_CONNECTION ||
          providerCalls >= MAX_PROVIDER_CALLS ||
          running.has(id) ||
          waiting() >= MAX_WAITING
        )
          return reply({ id, error: BUSY })
        const controller = new AbortController()
        running.set(id, controller)
        providerCalls++
        void settle(id, provider(values, controller.signal)).finally(() => {
          running.delete(id)
          providerCalls--
        })
        return
      }
      if (inFlight >= PER_CONNECTION || waiting() >= MAX_WAITING)
        return reply({ id, error: BUSY })
      inFlight++
      void settle(id, query(statements[call], values)).finally(() => {
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

  /** A cancelled or timed-out provider call is also stopped at the gateway. */
  call(
    call: GatewayCall,
    args: GatewayArgs,
    options: { signal?: AbortSignal; timeoutMs?: number } = {}
  ): Promise<unknown> {
    const socket = this.connect()
    const id = this.next++
    const { signal, timeoutMs = this.timeoutMs } = options
    return new Promise((resolve, reject) => {
      const stop = (code: string) => {
        if (!this.pending.delete(id)) return
        clearTimeout(timer)
        signal?.removeEventListener("abort", aborted)
        if (call === "provider" && !socket.destroyed)
          socket.write(JSON.stringify({ cancel: id }) + "\n")
        reject(failure(code))
      }
      const aborted = () => stop("ECANCELED")
      const timer = setTimeout(() => stop("ETIMEDOUT"), timeoutMs)
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", aborted)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener("abort", aborted)
          reject(error)
        },
        timer,
      })
      if (signal?.aborted) return aborted()
      signal?.addEventListener("abort", aborted, { once: true })
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
      if (this.buffer.length > MAX_REPLY) {
        socket.destroy()
        return
      }
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
