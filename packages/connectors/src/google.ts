import { z } from "zod"
import {
  parseGmailCall,
  gmailMessage,
  gmailWriteMessage,
} from "@agentonic/contracts/gmail"
import type { Keyring } from "./secrets"
// One scope (§83): reading, drafts, sending and labels (§68), the narrowest
// that can add a label to a message. It would also allow archiving and
// trashing; the platform's only change to a message adds user labels.
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"]
export type GoogleConfig = {
  clientId: string
  clientSecret: string
  redirectUri: string
  keys: Keyring
}
export class GoogleError extends Error {
  constructor(
    public code: "reconnect" | "unavailable" | "uncertain" | "rejected",
    /** A short category for logs, such as `gmail_http_503`; never provider text. */
    public reason?: string
  ) {
    super(code)
  }
}
async function json(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new GoogleError("unavailable")
  const parts: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > 2_000_000) {
      await reader.cancel()
      throw new GoogleError("unavailable", "gmail_too_large")
    }
    parts.push(value)
  }
  return JSON.parse(Buffer.concat(parts).toString()) as unknown
}
const token = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  expires_in: z.number().positive(),
  // Sent when the person granted access for a limited time.
  refresh_token_expires_in: z.number().positive().optional(),
})
// While the Google app is in Testing (B5, N26), each consent lasts 7 days.
// Set to false once the app is In production: later consents no longer expire.
export const GOOGLE_TESTING = true
const TESTING_GRANT_MS = 7 * 24 * 60 * 60 * 1000
/** When a consent's authorization ends, if it does: Testing's 7 days or Google's own lifetime, whichever is earlier (§84). */
export function grantExpiry(
  tokens: { refresh_token_expires_in?: number },
  now = Date.now()
) {
  const ends = [
    ...(GOOGLE_TESTING ? [now + TESTING_GRANT_MS] : []),
    ...(tokens.refresh_token_expires_in
      ? [now + tokens.refresh_token_expires_in * 1000]
      : []),
  ]
  return ends.length ? new Date(Math.min(...ends)).toISOString() : null
}
/** The authorization code's tokens; `scopes` are the ones the connection needs (Gmail's by default). */
export async function exchange(
  config: GoogleConfig,
  code: string,
  verifier: string,
  scopes: readonly string[] = GOOGLE_SCOPES
) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      code_verifier: verifier,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok) throw new GoogleError("reconnect")
  const result = token.parse(await json(response))
  if (
    !result.refresh_token ||
    !scopes.every((s) => result.scope?.split(" ").includes(s))
  )
    throw new GoogleError("reconnect")
  return result
}
export async function refresh(config: GoogleConfig, refreshToken: string) {
  return (await refreshGrant(config, refreshToken)).access
}
/** A fresh access token with the scopes Google granted it and its lifetime in seconds. */
export async function refreshGrant(config: GoogleConfig, refreshToken: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!response.ok)
    throw new GoogleError(response.status === 400 ? "reconnect" : "unavailable")
  const result = token.parse(await json(response))
  return {
    access: result.access_token,
    scopes: result.scope?.split(" ").filter(Boolean) ?? [],
    expiresIn: result.expires_in,
  }
}
export async function profile(access: string) {
  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/profile",
    {
      headers: { Authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(15000),
    }
  )
  if (!response.ok) throw new GoogleError("reconnect")
  return z
    .object({ emailAddress: z.email() })
    .parse(await json(response))
    .emailAddress.toLowerCase()
}
export async function revoke(refreshToken: string) {
  const response = await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    body: new URLSearchParams({ token: refreshToken }),
    signal: AbortSignal.timeout(15000),
  })
  return response.ok
}
/** What a reply carries from the message it answers (§67). */
export type ReplyContext = {
  threadId: string
  messageId?: string
  references: string[]
}
const headerId = /^<[^<>\s]{1,250}>$/
/**
 * Reads the thread and Message-ID of the message a reply answers. Only those
 * headers are requested; nothing of the message is returned to anyone.
 */
async function replyContext(access: string, id: string): Promise<ReplyContext> {
  let response: Response
  try {
    response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`,
      {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(15000),
      }
    )
  } catch {
    // Nothing was written yet.
    throw new GoogleError("unavailable")
  }
  if (!response.ok)
    throw new GoogleError(response.status === 401 ? "reconnect" : "rejected")
  const m = z
    .object({
      threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
      payload: z
        .object({
          headers: z
            .array(z.object({ name: z.string(), value: z.string() }))
            .optional(),
        })
        .optional(),
    })
    .parse(await json(response))
  const header = (name: string) =>
    m.payload?.headers
      ?.find((h) => h.name.toLowerCase() === name)
      ?.value.trim() ?? ""
  const messageId = header("message-id")
  return {
    threadId: m.threadId,
    messageId: headerId.test(messageId) ? messageId : undefined,
    references: header("references")
      .split(/\s+/)
      .filter((r) => headerId.test(r))
      .slice(-10),
  }
}
export function rawMessage(
  input: unknown,
  account: string,
  invocation: string,
  reply?: ReplyContext
) {
  const m = gmailMessage.parse(input)
  if (
    !z.email().safeParse(account).success ||
    /[\r\n]/.test(account) ||
    !z.uuid().safeParse(invocation).success
  )
    throw new Error("invalid_message")
  const lines = [
    `From: ${account}`,
    `To: ${m.to.join(", ")}`,
    ...(m.cc.length ? [`Cc: ${m.cc.join(", ")}`] : []),
    ...(m.bcc.length ? [`Bcc: ${m.bcc.join(", ")}`] : []),
    `Subject: =?UTF-8?B?${Buffer.from(m.subject).toString("base64")}?=`,
    `Message-ID: <${invocation}@agentonic.invalid>`,
    // A reply names the message it answers, so mail clients thread it.
    ...(reply?.messageId
      ? [
          `In-Reply-To: ${reply.messageId}`,
          `References: ${[
            ...reply.references.filter((r) => r !== reply.messageId),
            reply.messageId,
          ].join(" ")}`,
        ]
      : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.body)
      .toString("base64")
      .match(/.{1,76}/g)!
      .join("\r\n"),
  ]
  return Buffer.from(lines.join("\r\n")).toString("base64url")
}
const NO_TEXT = "Sin texto disponible. Los adjuntos no se descargan."
// Return plain text only. Never render provider HTML or fetch embedded links/attachments.
function message(
  value: unknown,
  headerNames = ["from", "to", "cc", "subject", "date"]
) {
  const part: z.ZodType<{
    mimeType?: string
    body?: { data?: string }
    parts?: unknown[]
    headers?: { name: string; value: string }[]
  }> = z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(z.unknown()).optional(),
    headers: z
      .array(z.object({ name: z.string(), value: z.string() }))
      .optional(),
  })
  const m = z
    .object({
      id: z.string(),
      threadId: z.string().optional(),
      snippet: z.string().optional(),
      payload: z.unknown(),
    })
    .parse(value)
  let total = 0
  function text(p: unknown, depth = 0): string {
    if (depth > 8 || total++ > 100) return ""
    const v = part.parse(p)
    if (v.mimeType === "text/plain" && v.body?.data)
      return Buffer.from(v.body.data, "base64url").toString().slice(0, 20000)
    return (v.parts ?? [])
      .map((x) => text(x, depth + 1))
      .join("\n")
      .slice(0, 20000)
  }
  const p = part.parse(m.payload)
  return {
    id: m.id,
    threadId: m.threadId,
    headers: p.headers?.filter((h) =>
      headerNames.includes(h.name.toLowerCase())
    ),
    text: text(m.payload) || m.snippet || NO_TEXT,
    untrusted: true,
  }
}
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/"
/** One Gmail request made by a labels proposal; `write` decides what a failure means. */
async function gmailCall(
  access: string,
  path: string,
  write: boolean,
  init: { method?: string; body?: unknown } = {}
) {
  let response: Response
  try {
    response = await fetch(GMAIL + path, {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${access}`,
        "Content-Type": "application/json",
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(15000),
    })
  } catch {
    throw new GoogleError(write ? "uncertain" : "unavailable")
  }
  // A token without gmail.modify (connected before §68) gets a 403: refused.
  if (!response.ok)
    throw new GoogleError(
      response.status === 401
        ? "reconnect"
        : write && response.status >= 500
          ? "uncertain"
          : "rejected",
      `gmail_http_${response.status}`
    )
  return response.status === 204 ? null : json(response)
}
const sameSubject = (a: string, b: string) =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim()
/**
 * Applies a confirmed labels proposal (§68). First, with nothing changed,
 * every message's subject must match the one the card showed, and missing
 * labels are found. Then the missing user labels are created and each label is
 * added to its messages. Gmail's own labels are never touched.
 */
async function applyLabels(
  access: string,
  items: { messageId: string; subject: string; label: string }[]
) {
  for (const item of items) {
    const m = z
      .object({
        payload: z
          .object({
            headers: z
              .array(z.object({ name: z.string(), value: z.string() }))
              .optional(),
          })
          .optional(),
      })
      .parse(
        await gmailCall(
          access,
          `messages/${encodeURIComponent(item.messageId)}?format=metadata&metadataHeaders=Subject`,
          false
        )
      )
    const subject =
      m.payload?.headers?.find((h) => h.name.toLowerCase() === "subject")
        ?.value ?? ""
    if (!sameSubject(subject, item.subject))
      throw new GoogleError("rejected", "gmail_subject_mismatch")
  }
  const existing = z
    .object({
      labels: z
        .array(z.object({ id: z.string(), name: z.string(), type: z.string() }))
        .optional(),
    })
    .parse(await gmailCall(access, "labels", false))
  const ids = new Map<string, string>()
  for (const l of existing.labels ?? [])
    if (l.type === "user") ids.set(l.name.toLowerCase(), l.id)
  let created = 0
  const byLabel = new Map<string, string[]>()
  for (const item of items) {
    const key = item.label.toLowerCase()
    if (!ids.has(key)) {
      const label = z.object({ id: z.string() }).parse(
        await gmailCall(access, "labels", true, {
          method: "POST",
          body: {
            name: item.label,
            labelListVisibility: "labelShow",
            messageListVisibility: "show",
          },
        })
      )
      ids.set(key, label.id)
      created++
    }
    byLabel.set(key, [...(byLabel.get(key) ?? []), item.messageId])
  }
  for (const [key, messageIds] of byLabel)
    await gmailCall(access, "messages/batchModify", true, {
      method: "POST",
      body: { ids: messageIds, addLabelIds: [ids.get(key)] },
    })
  return { labeled: items.length, created }
}
/** A whole thread, most recent 10 messages, each cut to 4,000 characters (§68). */
const THREAD_MESSAGES = 10
const THREAD_TEXT = 4000
export async function gmail(
  access: string,
  operation: string,
  args: unknown,
  account: string,
  invocation: string
) {
  const call = parseGmailCall(operation, args),
    a = call.arguments as Record<string, unknown>
  if (operation === "gmail.labels.apply")
    return applyLabels(
      access,
      a.labels as { messageId: string; subject: string; label: string }[]
    )
  let path = "",
    method = "GET",
    body: unknown
  if (operation === "gmail.search")
    path = `messages?${new URLSearchParams({ q: String(a.query), maxResults: String(a.limit) })}`
  if (operation === "gmail.read") path = `messages/${a.id}?format=full`
  if (operation === "gmail.threads.read") path = `threads/${a.id}?format=full`
  if (operation === "gmail.drafts.list") path = `drafts?maxResults=${a.limit}`
  if (operation === "gmail.drafts.read") path = `drafts/${a.id}?format=full`
  // A reply goes in the thread of the message it answers (§67).
  const replyTo = (
    gmailWriteMessage(call.operation, a) as { replyTo?: string | null } | null
  )?.replyTo
  const reply =
    replyTo &&
    ["gmail.drafts.create", "gmail.drafts.update", "gmail.send"].includes(
      call.operation
    )
      ? await replyContext(access, replyTo)
      : undefined
  const thread = reply ? { threadId: reply.threadId } : {}
  if (
    operation === "gmail.drafts.create" ||
    operation === "gmail.drafts.update"
  ) {
    path = operation.endsWith("update") ? `drafts/${a.id}` : "drafts"
    method = operation.endsWith("update") ? "PUT" : "POST"
    body = {
      message: {
        raw: rawMessage(a.message ?? a, account, invocation, reply),
        ...thread,
      },
    }
  }
  if (operation === "gmail.drafts.delete") {
    path = `drafts/${a.id}`
    method = "DELETE"
  }
  if (operation === "gmail.send") {
    path = "messages/send"
    method = "POST"
    body = { raw: rawMessage(a, account, invocation, reply), ...thread }
  }
  const write = method !== "GET"
  let response: Response
  try {
    response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${access}`,
          "Content-Type": "application/json",
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      }
    )
  } catch {
    throw new GoogleError(write ? "uncertain" : "unavailable")
  }
  if (!response.ok)
    throw new GoogleError(
      response.status === 401
        ? "reconnect"
        : write && response.status >= 500
          ? "uncertain"
          : "rejected"
    )
  if (response.status === 204) return { deleted: true }
  let data: unknown
  try {
    data = await json(response)
  } catch {
    throw new GoogleError(write ? "uncertain" : "unavailable")
  }
  if (operation === "gmail.read") return message(data)
  if (operation === "gmail.threads.read") {
    const thread = z
      .object({ id: z.string(), messages: z.array(z.unknown()).optional() })
      .parse(data)
    const all = thread.messages ?? []
    return {
      threadId: thread.id,
      messages: all.slice(-THREAD_MESSAGES).map((m) => {
        const read = message(m)
        return {
          ...read,
          text: read.text.slice(0, THREAD_TEXT),
          ...(read.text.length > THREAD_TEXT ? { truncated: true } : {}),
        }
      }),
      ...(all.length > THREAD_MESSAGES
        ? { earlierMessages: all.length - THREAD_MESSAGES }
        : {}),
      untrusted: true,
    }
  }
  // Drafts name both IDs so the model edits by draftId, never the message's.
  if (operation === "gmail.drafts.read") {
    const draft = z.object({ id: z.string(), message: z.unknown() }).parse(data)
    const { id: messageId, ...rest } = message(draft.message)
    return { draftId: draft.id, messageId, ...rest }
  }
  // IDs and bounded metadata only; reads require their own permission recheck.
  if (operation === "gmail.search")
    return z
      .object({
        messages: z
          .array(z.object({ id: z.string(), threadId: z.string() }))
          .max(10)
          .optional(),
        nextPageToken: z.string().optional(),
      })
      .parse(data)
  if (operation === "gmail.drafts.list") {
    const list = z
      .object({
        drafts: z
          .array(
            z.object({
              id: z.string(),
              message: z.object({ id: z.string(), threadId: z.string() }),
            })
          )
          .max(10)
          .optional(),
      })
      .parse(data)
    return {
      drafts: list.drafts?.map((draft) => ({
        draftId: draft.id,
        messageId: draft.message.id,
        threadId: draft.message.threadId,
      })),
    }
  }
  return z
    .object({
      id: z.string(),
      threadId: z.string().optional(),
      message: z.object({ id: z.string() }).optional(),
    })
    .parse(data)
}

/**
 * The conversation a proposed reply answers, read when its owner opens the
 * proposal's card (§81): the thread's latest 10 messages, oldest first, as
 * plain text like gmail.threads.read. Shown to the owner, never stored.
 */
export async function replyThread(access: string, messageId: string) {
  const { threadId } = await replyContext(access, messageId)
  let response: Response
  try {
    response = await fetch(
      `${GMAIL}threads/${encodeURIComponent(threadId)}?format=full`,
      {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.timeout(15000),
      }
    )
  } catch {
    throw new GoogleError("unavailable")
  }
  if (!response.ok)
    throw new GoogleError(response.status === 401 ? "reconnect" : "rejected")
  const all =
    z
      .object({ messages: z.array(z.unknown()).optional() })
      .parse(await json(response)).messages ?? []
  return {
    messages: all.slice(-THREAD_MESSAGES).map((m) => {
      const { id, headers, text } = message(m)
      const header = (name: string) =>
        headers?.find((h) => h.name.toLowerCase() === name)?.value ?? ""
      return {
        id,
        from: header("from"),
        to: header("to"),
        cc: header("cc"),
        subject: header("subject"),
        date: header("date"),
        text: text.trim(),
        answered: id === messageId,
      }
    }),
    earlierMessages: Math.max(0, all.length - THREAD_MESSAGES),
  }
}

// Aprender mi estilo (architecture §57): the account's own sent mail, read once
// in the worker's memory. Nothing here is stored. A run makes hundreds of reads
// in a row, so a passing Gmail error (a 5xx, a dropped connection) is retried
// with backoff instead of ending the run. A rate limit is not retried here: the
// caller paces its reads and decides how long to wait (GmailRateLimited).
const READ_RETRIES = 4
/** A failure worth another try. */
class Passing extends GoogleError {
  constructor(reason: string) {
    super("unavailable", reason)
  }
}
/** Gmail asked the account to slow down; `waitMs` is the wait it named, if any. */
export class GmailRateLimited extends GoogleError {
  constructor(
    reason: string,
    public waitMs: number | null
  ) {
    super("unavailable", reason)
  }
}
/** A Retry-After header (seconds or a date), or Gmail's "Retry after <time>" message. */
function namedWait(header: string | null, body: string) {
  const at = header?.trim()
    ? /^\d+$/.test(header.trim())
      ? Date.now() + Number(header) * 1000
      : Date.parse(header)
    : Date.parse(/Retry after (\S+?Z)/i.exec(body)?.[1] ?? "")
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null
}
function pause(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => {
      clearTimeout(timer)
      reject(new GoogleError("unavailable"))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop)
      resolve()
    }, ms)
    signal?.addEventListener("abort", stop, { once: true })
  })
}
async function readOnce(access: string, path: string, signal?: AbortSignal) {
  let response: Response
  try {
    response = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/${path}`,
      {
        headers: { Authorization: `Bearer ${access}` },
        signal: AbortSignal.any([
          AbortSignal.timeout(15000),
          ...(signal ? [signal] : []),
        ]),
      }
    )
  } catch (error) {
    throw new Passing(
      error instanceof Error && error.name === "TimeoutError"
        ? "gmail_timeout"
        : "gmail_network"
    )
  }
  if (response.status === 401) throw new GoogleError("reconnect")
  if (!response.ok) {
    const reason = `gmail_http_${response.status}`
    const body = JSON.stringify(await json(response).catch(() => null))
    // Only the kind of limit reaches the logs, never Google's message.
    const limit = /userRateLimitExceeded/.test(body)
      ? "_user_rate_limit"
      : /rateLimitExceeded|RATE_LIMIT_EXCEEDED/.test(body)
        ? "_rate_limit"
        : ""
    if (response.status === 429 || (response.status === 403 && limit))
      throw new GmailRateLimited(
        reason + limit,
        namedWait(response.headers.get("retry-after"), body)
      )
    if ([500, 502, 503, 504].includes(response.status))
      throw new Passing(reason)
    throw new GoogleError("rejected", reason)
  }
  try {
    return await json(response)
  } catch (error) {
    // Too large stays too large; a dropped body is worth another try.
    if (error instanceof GoogleError && error.reason === "gmail_too_large")
      throw new GoogleError("rejected", error.reason)
    throw new Passing("gmail_body")
  }
}
async function read(access: string, path: string, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readOnce(access, path, signal)
    } catch (error) {
      if (
        !(error instanceof Passing) ||
        attempt >= READ_RETRIES ||
        signal?.aborted
      )
        throw error
      await pause(500 * 2 ** attempt * (0.75 + Math.random() / 2), signal)
    }
  }
}
/** IDs of messages the account sent in the last `days` days, newest first. */
export async function sentMessageIds(
  access: string,
  days: number,
  max: number,
  signal?: AbortSignal
) {
  const ids: string[] = []
  let pageToken: string | undefined
  do {
    const page = z
      .object({
        messages: z.array(z.object({ id: z.string() })).optional(),
        nextPageToken: z.string().optional(),
      })
      .parse(
        await read(
          access,
          `messages?${new URLSearchParams({
            q: `in:sent newer_than:${days}d -in:chats`,
            maxResults: String(Math.min(100, max - ids.length)),
            ...(pageToken ? { pageToken } : {}),
          })}`,
          signal
        )
      )
    ids.push(...(page.messages ?? []).map((m) => m.id))
    pageToken = page.nextPageToken
  } while (pageToken && ids.length < max)
  return ids.slice(0, max)
}
/** One sent message: the headers that tell who wrote it and how, and its text. */
export async function readSentMessage(
  access: string,
  id: string,
  signal?: AbortSignal
) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new GoogleError("rejected")
  const m = message(await read(access, `messages/${id}?format=full`, signal), [
    "from",
    "to",
    "cc",
    "subject",
    "auto-submitted",
    "in-reply-to",
  ])
  const header = (name: string) =>
    m.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? ""
  return {
    from: header("from"),
    to: header("to"),
    cc: header("cc"),
    subject: header("subject"),
    autoSubmitted: header("auto-submitted"),
    reply: header("in-reply-to") !== "",
    text: m.text === NO_TEXT ? "" : m.text,
  }
}
