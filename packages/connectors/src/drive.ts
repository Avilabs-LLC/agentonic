import { z } from "zod"
import {
  DRIVE_FILE_SCOPE,
  DRIVE_MAX_BYTES,
  GOOGLE_DOC,
  GOOGLE_SHEET,
  GOOGLE_SLIDES,
  parseDriveProposal,
  supportedDriveType,
} from "@agentonic/contracts/drive"
import { GoogleError, refreshGrant, type GoogleConfig } from "./google"

// Google Drive with the drive.file scope (architecture §62): only files a
// person picked in Agentonic and files Agentonic created are reachable. Every
// call has a timeout and a size limit; provider text never reaches a log.
const API = "https://www.googleapis.com/drive/v3"
const UPLOAD = "https://www.googleapis.com/upload/drive/v3"
/** Scopes a Drive token may carry before Agentonic hands it to Google's Picker. */
const PICKER_SCOPES = new Set([
  DRIVE_FILE_SCOPE,
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
])
export const DRIVE_OAUTH_SCOPES = [DRIVE_FILE_SCOPE] as const

/** Why Drive refused a file; nothing else about the file is kept. */
export type DriveFileProblem =
  | "not_found"
  | "no_access"
  | "trashed"
  | "too_large"
  | "unsupported"
  | "changed"
export class DriveFileError extends GoogleError {
  constructor(public problem: DriveFileProblem) {
    super("rejected", `drive_${problem}`)
  }
}

async function bytes(response: Response, limit = DRIVE_MAX_BYTES) {
  const reader = response.body?.getReader()
  if (!reader) throw new GoogleError("unavailable", "drive_empty")
  const parts: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      throw new DriveFileError("too_large")
    }
    parts.push(value)
  }
  return Buffer.concat(parts)
}
const reasons = z
  .object({
    error: z
      .object({
        errors: z.array(z.object({ reason: z.string() })).optional(),
      })
      .optional(),
  })
  .catch({})
/** Maps a refused response to a code; a write's 5xx may have taken effect. */
async function refused(response: Response, write: boolean): Promise<never> {
  if (response.status === 401) throw new GoogleError("reconnect", "drive_401")
  if (response.status === 404) throw new DriveFileError("not_found")
  const body = await bytes(response, 100_000).catch(() => Buffer.alloc(0))
  let parsed: z.infer<typeof reasons> = {}
  try {
    parsed = reasons.parse(JSON.parse(body.toString()))
  } catch {
    parsed = {}
  }
  const reason = parsed.error?.errors?.[0]?.reason ?? ""
  if (response.status === 403 && reason === "exportSizeLimitExceeded")
    throw new DriveFileError("too_large")
  if (
    response.status === 429 ||
    (response.status === 403 && /rateLimitExceeded/i.test(reason))
  )
    throw new GoogleError("unavailable", `drive_http_${response.status}`)
  if (response.status === 403) throw new DriveFileError("no_access")
  if (response.status >= 500)
    throw new GoogleError(
      write ? "uncertain" : "unavailable",
      `drive_http_${response.status}`
    )
  throw new GoogleError("rejected", `drive_http_${response.status}`)
}
async function request(
  access: string,
  url: string,
  init: RequestInit = {},
  write = false
) {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${access}` },
      signal: AbortSignal.timeout(20000),
    })
  } catch (error) {
    throw new GoogleError(
      write ? "uncertain" : "unavailable",
      error instanceof Error && error.name === "TimeoutError"
        ? "drive_timeout"
        : "drive_network"
    )
  }
  if (!response.ok) await refused(response, write)
  return response
}
async function json(response: Response, write = false) {
  try {
    return JSON.parse((await bytes(response, 2_000_000)).toString()) as unknown
  } catch (error) {
    if (error instanceof GoogleError) throw error
    throw new GoogleError(write ? "uncertain" : "unavailable", "drive_json")
  }
}

/** The connected account, from Drive itself, never from a form or the model. */
export async function driveAccount(access: string) {
  const response = await request(
    access,
    `${API}/about?fields=user(emailAddress)`
  ).catch((error) => {
    throw error instanceof GoogleError && error.code === "unavailable"
      ? error
      : new GoogleError("reconnect", "drive_identity")
  })
  return z
    .object({ user: z.object({ emailAddress: z.email() }) })
    .parse(await json(response))
    .user.emailAddress.toLowerCase()
}

/**
 * A short-lived token for Google's Picker, for the connection's own member.
 * Refused unless Google granted it drive.file and nothing broader, so a
 * browser can never receive Gmail or whole-Drive access. The refresh token
 * itself never leaves the server.
 */
export async function pickerToken(config: GoogleConfig, refreshToken: string) {
  const grant = await refreshGrant(config, refreshToken)
  if (
    !grant.scopes.includes(DRIVE_FILE_SCOPE) ||
    grant.scopes.some((scope) => !PICKER_SCOPES.has(scope))
  )
    throw new GoogleError("rejected", "drive_picker_scope")
  return { token: grant.access, expiresIn: grant.expiresIn }
}

export const driveMetadata = z.object({
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  version: z.string().regex(/^\d{1,20}$/),
  modifiedTime: z.string().optional(),
  trashed: z.boolean().optional(),
  size: z.string().optional(),
})
export type DriveMetadata = z.infer<typeof driveMetadata>
const files = (id: string) => `${API}/files/${encodeURIComponent(id)}`
/** A file's name, type and version; a trashed or unreadable file is refused. */
export async function fileMetadata(access: string, fileId: string) {
  const meta = driveMetadata.parse(
    await json(
      await request(
        access,
        `${files(fileId)}?fields=id,name,mimeType,version,modifiedTime,trashed,size&supportsAllDrives=true`
      )
    )
  )
  if (meta.id !== fileId) throw new DriveFileError("not_found")
  if (meta.trashed) throw new DriveFileError("trashed")
  if (!supportedDriveType(meta.mimeType))
    throw new DriveFileError("unsupported")
  if (meta.size && Number(meta.size) > DRIVE_MAX_BYTES)
    throw new DriveFileError("too_large")
  return meta
}
/**
 * A file's content as Agentonic reads it: Docs as Markdown, Sheets as CSV
 * (Google exports the first sheet), Slides as plain text, PDFs and text files
 * as they are. Never more than 10 MB.
 */
export async function fileContent(access: string, meta: DriveMetadata) {
  const exported: Record<string, string> = {
    [GOOGLE_DOC]: "text/markdown",
    [GOOGLE_SHEET]: "text/csv",
    [GOOGLE_SLIDES]: "text/plain",
  }
  const as = exported[meta.mimeType]
  const url = as
    ? `${files(meta.id)}/export?mimeType=${encodeURIComponent(as)}`
    : `${files(meta.id)}?alt=media&supportsAllDrives=true`
  return {
    bytes: await bytes(await request(access, url)),
    format: meta.mimeType === "application/pdf" ? ("pdf" as const) : ("text" as const),
    exported: Boolean(as),
  }
}
/** A Google Doc's current text, for the confirmation of an update. */
export async function docText(access: string, fileId: string) {
  const meta = await fileMetadata(access, fileId)
  if (meta.mimeType !== GOOGLE_DOC) throw new DriveFileError("unsupported")
  const content = await fileContent(access, meta)
  return {
    name: meta.name,
    version: meta.version,
    text: new TextDecoder().decode(content.bytes),
  }
}

// Writes -----------------------------------------------------------------------
let markdownImport: boolean | undefined
/** Whether Drive converts Markdown into a Google Doc; plain text otherwise. */
async function importType(access: string) {
  if (markdownImport === undefined) {
    const formats = z
      .object({ importFormats: z.record(z.string(), z.array(z.string())) })
      .catch({ importFormats: {} })
      .parse(
        await json(await request(access, `${API}/about?fields=importFormats`))
      )
    markdownImport = Boolean(
      formats.importFormats["text/markdown"]?.includes(GOOGLE_DOC)
    )
  }
  return markdownImport ? "text/markdown" : "text/plain"
}
const written = z.object({ id: z.string(), name: z.string() })
async function createDoc(access: string, title: string, body: string) {
  const type = await importType(access)
  const boundary = `agentonic-${crypto.randomUUID()}`
  const payload = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    JSON.stringify({ name: title, mimeType: GOOGLE_DOC }),
    `--${boundary}`,
    `Content-Type: ${type}; charset=UTF-8`,
    "",
    body,
    `--${boundary}--`,
    "",
  ].join("\r\n")
  const response = await request(
    access,
    `${UPLOAD}/files?uploadType=multipart&fields=id,name`,
    {
      method: "POST",
      headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
      body: payload,
    },
    true
  )
  const file = written.parse(await json(response, true))
  return { fileId: file.id, name: file.name }
}
/**
 * Replaces a Doc's content, only if Drive still shows the version the person
 * confirmed. The check and the write are separate calls, so an edit made in
 * between can still be overwritten; the version check catches the rest.
 */
async function updateDoc(
  access: string,
  fileId: string,
  body: string,
  version: string
) {
  const meta = await fileMetadata(access, fileId)
  if (meta.mimeType !== GOOGLE_DOC) throw new DriveFileError("unsupported")
  if (meta.version !== version) throw new DriveFileError("changed")
  const type = await importType(access)
  const response = await request(
    access,
    `${UPLOAD}/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,name&supportsAllDrives=true`,
    {
      method: "PATCH",
      headers: { "Content-Type": `${type}; charset=UTF-8` },
      body,
    },
    true
  )
  const file = written.parse(await json(response, true))
  return { fileId: file.id, name: file.name }
}
/** One confirmed write, exactly as confirmed; one attempt, never retried. */
export async function driveWrite(
  access: string,
  operation: string,
  args: unknown
) {
  const call = parseDriveProposal(operation, args)
  if (call.operation === "drive.docs.create") {
    const a = call.arguments as { title: string; body: string }
    return createDoc(access, a.title, a.body)
  }
  const a = call.arguments as {
    id: string
    body: string
    version: string
  }
  return updateDoc(access, a.id, a.body, a.version)
}
