import { z } from "zod"
import { parseGmailCall, gmailMessage } from "@agentonic/contracts/gmail"
import type { Keyring } from "./secrets"
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
]
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
})
export async function exchange(
  config: GoogleConfig,
  code: string,
  verifier: string
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
    !GOOGLE_SCOPES.every((s) => result.scope?.split(" ").includes(s))
  )
    throw new GoogleError("reconnect")
  return result
}
export async function refresh(config: GoogleConfig, refreshToken: string) {
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
  return token.parse(await json(response)).access_token
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
export function rawMessage(
  input: unknown,
  account: string,
  invocation: string
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
export async function gmail(
  access: string,
  operation: string,
  args: unknown,
  account: string,
  invocation: string
) {
  const call = parseGmailCall(operation, args),
    a = call.arguments as Record<string, unknown>
  let path = "",
    method = "GET",
    body: unknown
  if (operation === "gmail.search")
    path = `messages?${new URLSearchParams({ q: String(a.query), maxResults: String(a.limit) })}`
  if (operation === "gmail.read") path = `messages/${a.id}?format=full`
  if (operation === "gmail.drafts.list") path = `drafts?maxResults=${a.limit}`
  if (operation === "gmail.drafts.read") path = `drafts/${a.id}?format=full`
  if (
    operation === "gmail.drafts.create" ||
    operation === "gmail.drafts.update"
  ) {
    path = operation.endsWith("update") ? `drafts/${a.id}` : "drafts"
    method = operation.endsWith("update") ? "PUT" : "POST"
    body = { message: { raw: rawMessage(a.message ?? a, account, invocation) } }
  }
  if (operation === "gmail.drafts.delete") {
    path = `drafts/${a.id}`
    method = "DELETE"
  }
  if (operation === "gmail.send") {
    path = "messages/send"
    method = "POST"
    body = { raw: rawMessage(a, account, invocation) }
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

// Aprender mi estilo (architecture §57): the account's own sent mail, read once
// in the worker's memory. Nothing here is stored. A run makes hundreds of reads
// in a row, so a passing Gmail error (a 5xx, a rate limit, a dropped
// connection) is retried with backoff instead of ending the run.
const READ_RETRIES = 4
const rateLimited =
  /rateLimitExceeded|userRateLimitExceeded|RATE_LIMIT_EXCEEDED/
/** A failure worth another try, with the wait Google asked for, if any. */
class Passing extends GoogleError {
  constructor(
    reason: string,
    public retryAfter: string | null = null
  ) {
    super("unavailable", reason)
  }
}
/** Retry-After in seconds or as a date, at most 30 s; otherwise exponential with jitter. */
function backoff(attempt: number, retryAfter: string | null) {
  if (retryAfter) {
    const asked = /^\d+$/.test(retryAfter.trim())
      ? Number(retryAfter) * 1000
      : Date.parse(retryAfter) - Date.now()
    if (Number.isFinite(asked)) return Math.min(30000, Math.max(0, asked))
  }
  return 500 * 2 ** attempt * (0.75 + Math.random() / 2)
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
    if (
      [429, 500, 502, 503, 504].includes(response.status) ||
      (response.status === 403 && rateLimited.test(body))
    )
      throw new Passing(reason, response.headers.get("retry-after"))
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
      await pause(backoff(attempt, error.retryAfter), signal)
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
