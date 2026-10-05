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
    public code: "reconnect" | "unavailable" | "uncertain" | "rejected"
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
      throw new GoogleError("unavailable")
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
// Return plain text only. Never render provider HTML or fetch embedded links/attachments.
function message(value: unknown) {
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
      ["from", "to", "cc", "subject", "date"].includes(h.name.toLowerCase())
    ),
    text:
      text(m.payload) ||
      m.snippet ||
      "Sin texto disponible. Los adjuntos no se descargan.",
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
  if (operation === "gmail.drafts.read")
    return message(z.object({ message: z.unknown() }).parse(data).message)
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
  if (operation === "gmail.drafts.list")
    return z
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
  return z
    .object({
      id: z.string(),
      threadId: z.string().optional(),
      message: z.object({ id: z.string() }).optional(),
    })
    .parse(data)
}
