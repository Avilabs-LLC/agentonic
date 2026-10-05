// Waiting and failure reports for the long-running staging services (deployment
// controller, agent services, evaluator). A refused registration or an
// unreachable database is a state to wait out, not a reason to exit: each
// service retries with backoff and writes one JSON line per change of state, so
// the journal says why it is idle. Lines carry categories, never content.

/** Categories for errors raised while talking to the database. */
export type Reason =
  | "refused"
  | "database_unreachable"
  | "database_busy"
  | "database_error"
  | "unexpected"

const UNREACHABLE = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
])
// Too many connections, administrator shutdown, cannot connect now, statement timeout.
const BUSY = new Set(["53300", "57P01", "57P03", "57014"])

/** Maps a database or network error to a reason without reading its message text. */
export function categorize(error: unknown): Reason {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : undefined
  // insufficient_privilege: every staging function raises it for a refused identity.
  if (code === "42501") return "refused"
  if (code && (UNREACHABLE.has(code) || code.startsWith("08")))
    return "database_unreachable"
  if (code && BUSY.has(code)) return "database_busy"
  if (code && /^[0-9A-Z]{5}$/.test(code)) return "database_error"
  // node-postgres reports connection timeouts and dropped sockets without a code.
  if (error instanceof Error && /timeout|terminated/i.test(error.message))
    return "database_unreachable"
  return "unexpected"
}

/** Our own error codes (`runtime_mismatch`, ...) pass through; anything else is categorized. */
export function reasonOf(error: unknown) {
  return error instanceof Error && /^[a-z][a-z_]{2,40}$/.test(error.message)
    ? error.message
    : categorize(error)
}

export type Backoff = { first: number; max: number }
export const FAST: Backoff = { first: 5_000, max: 30_000 }
export const SLOW: Backoff = { first: 5_000, max: 60_000 }

export function backoff(attempt: number, { first, max }: Backoff) {
  return Math.min(max, first * 2 ** Math.max(0, attempt - 1))
}

type Line = Record<string, unknown>
const journal = (line: Line) => console.error(JSON.stringify(line))
type Options = {
  log?: (line: Line) => void
  now?: () => number
  /** Repeat a waiting line this often while the state persists. */
  reminderMs?: number
}
type Open = {
  reason: string
  since: number
  attempts: number
  logged?: number
  next: number
}

/**
 * Open incidents keyed by subject (the service itself, or one deployment).
 * `fail` records an attempt and returns the delay before the next one; it logs
 * when a subject starts failing, when the reason changes and every reminder
 * interval. `ok` logs the recovery of a failing subject.
 */
export class Incidents {
  private readonly open = new Map<string, Open>()
  private readonly log: (line: Line) => void
  private readonly now: () => number
  private readonly reminderMs: number
  constructor(
    private readonly prefix: string,
    private readonly fields: Line = {},
    options: Options = {}
  ) {
    this.log = options.log ?? journal
    this.now = options.now ?? Date.now
    this.reminderMs = options.reminderMs ?? 10 * 60_000
  }
  fail(key: string, reason: string, fields: Line = {}, policy = SLOW) {
    const now = this.now()
    let entry = this.open.get(key)
    if (!entry || entry.reason !== reason) {
      entry = { reason, since: now, attempts: 0, next: now }
      this.open.set(key, entry)
    }
    entry.attempts++
    const wait = backoff(entry.attempts, policy)
    entry.next = now + wait
    if (entry.logged === undefined || now - entry.logged >= this.reminderMs) {
      this.log({
        event: `${this.prefix}_waiting`,
        ...this.fields,
        ...fields,
        reason,
        since: new Date(entry.since).toISOString(),
        attempts: entry.attempts,
        retryInSeconds: Math.round(wait / 1000),
      })
      entry.logged = now
    }
    return wait
  }
  ok(key: string, fields: Line = {}) {
    const entry = this.open.get(key)
    if (!entry) return
    this.open.delete(key)
    this.log({
      event: `${this.prefix}_recovered`,
      ...this.fields,
      ...fields,
      reason: entry.reason,
      waitedSeconds: Math.round((this.now() - entry.since) / 1000),
    })
  }
  /** Whether a failing subject's next attempt is due. */
  due(key: string) {
    const entry = this.open.get(key)
    return !entry || this.now() >= entry.next
  }
}

/** One service's lifecycle lines: started, waiting, recovered and stopped. */
export class ServiceState {
  private readonly incidents: Incidents
  private readonly log: (line: Line) => void
  constructor(
    private readonly service: string,
    private readonly fields: Line = {},
    options: Options = {}
  ) {
    this.incidents = new Incidents("service", { service, ...fields }, options)
    this.log = options.log ?? journal
  }
  private write(event: string, line: Line) {
    this.log({ event, service: this.service, ...this.fields, ...line })
  }
  started(fields: Line = {}) {
    this.write("service_started", fields)
  }
  /** Records a failed attempt and returns how long to wait before retrying. */
  waiting(reason: string, policy = SLOW) {
    return this.incidents.fail("service", reason, {}, policy)
  }
  recovered() {
    this.incidents.ok("service")
  }
  stopped(reason: string) {
    this.write("service_stopped", { reason })
  }
}
