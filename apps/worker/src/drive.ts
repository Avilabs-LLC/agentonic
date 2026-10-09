// Google Drive in the worker (architecture §62): an agent's tool calls on the
// files picked for it, the knowledge sync of a curator's imported files, and
// a write a schedule pre-authorized. Credentials are unsealed only here and
// in the customer app; the model and the runtime never see them.
import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import {
  DRIVE_READ_CHARACTERS,
  GOOGLE_DOC,
  driveCredential,
  driveGrant,
  driveTypes,
  parseDriveCall,
  parseDriveProposal,
} from "@agentonic/contracts/drive"
import { refresh, GoogleError, type GoogleConfig } from "@agentonic/connectors/google"
import {
  DriveFileError,
  driveWrite,
  fileContent,
  fileMetadata,
  type DriveMetadata,
} from "@agentonic/connectors/drive"
import { digest, seal, unseal } from "@agentonic/connectors/secrets"
import { chunkPages, type PageText } from "./chunking"
import type { Execute, Lease } from "./pipeline"

/** The PDF parser runs in its own bounded process (pipeline.ts). */
export type ParsePdf = (bytes: Buffer, signal: AbortSignal) => Promise<PageText[]>

const authority = z.object({
  credential: z.string(),
  account: z.string(),
  files: z
    .array(z.object({ fileId: z.string(), name: z.string(), mimeType: z.string() }))
    .max(50),
})
async function accessToken(
  config: GoogleConfig,
  credential: string,
  connectionId: string,
  reconnect: () => Promise<unknown>
) {
  const { refreshToken } = driveCredential.parse(
    unseal(credential, `drive:${connectionId}`, config.keys)
  )
  try {
    return await refresh(config, refreshToken)
  } catch (error) {
    if (error instanceof GoogleError && error.code === "reconnect") await reconnect()
    throw error
  }
}
/** A file's text as the model or the index reads it. */
async function fileText(
  token: string,
  meta: DriveMetadata,
  parsePdf: ParsePdf,
  signal: AbortSignal
) {
  const content = await fileContent(token, meta)
  const pages =
    content.format === "pdf"
      ? await parsePdf(content.bytes, signal)
      : [{ text: new TextDecoder().decode(content.bytes) }]
  return { content, pages }
}
const type = (mimeType: string) => driveTypes[mimeType] ?? "Archivo"

/**
 * One Drive tool call of a turn. Reads return current Drive content, marked
 * untrusted; writes only become a sealed proposal the person confirms (or a
 * schedule pre-authorized). The database rechecks the grant, the connection
 * and the agent's files at every step; a file outside them is never read.
 */
export async function executeDrive(
  name: string,
  args: unknown,
  grant: unknown,
  job: Lease,
  execute: Execute,
  config: GoogleConfig,
  parsePdf: ParsePdf,
  signal: AbortSignal
) {
  const g = driveGrant.parse(grant),
    call = parseDriveCall(name, args)
  if (!g.operations.includes(call.operation)) throw new Error("drive_denied")
  const payload = { connectionId: g.driveConnectionId, operation: call.operation }
  const propose = async (proposal: unknown, fileId?: string) => {
    const parsed = parseDriveProposal(call.operation, proposal)
    const id = randomUUID()
    return execute("drive-propose", job, {
      ...payload,
      id,
      hash: digest(JSON.stringify(parsed.arguments)),
      argumentsCiphertext: seal(parsed.arguments, `invocation:${id}`, config.keys),
      ...(fileId ? { fileId } : {}),
    })
  }
  if (call.operation === "drive.docs.create") return propose(call.arguments)
  const held = authority.parse(await execute("drive-read", job, payload))
  if (call.operation === "drive.files.list") {
    const filter = (call.arguments as { name: string }).name.trim().toLowerCase()
    return {
      files: held.files
        .filter((f) => !filter || f.name.toLowerCase().includes(filter))
        .map((f) => ({ id: f.fileId, name: f.name, type: type(f.mimeType) })),
      untrusted: true,
    }
  }
  const id = (call.arguments as { id: string }).id
  const file = held.files.find((f) => f.fileId === id)
  // A model-supplied ID outside the agent's files reaches nothing.
  if (!file) return { error: "not_in_agent_files", untrusted: true }
  const token = await accessToken(config, held.credential, g.driveConnectionId, () =>
    execute("drive-reconnect", job, payload)
  )
  let meta: DriveMetadata
  try {
    meta = await fileMetadata(token, id)
  } catch (error) {
    if (error instanceof DriveFileError) return { error: error.problem, untrusted: true }
    throw error
  }
  if (call.operation === "drive.docs.update") {
    if (meta.mimeType !== GOOGLE_DOC) return { error: "not_a_google_doc", untrusted: true }
    // The confirmation is bound to the Doc's name and the version seen now.
    return propose(
      {
        id,
        body: (call.arguments as { body: string }).body,
        name: meta.name.slice(0, 500),
        version: meta.version,
      },
      id
    )
  }
  let text: string
  try {
    text = (await fileText(token, meta, parsePdf, signal)).pages
      .map((p) => p.text)
      .join("\n")
  } catch (error) {
    if (error instanceof DriveFileError) return { error: error.problem, untrusted: true }
    if (error instanceof Error && error.message === "invalid_document")
      return { error: "unreadable", untrusted: true }
    throw error
  }
  // Authority is checked again before anything read reaches the model.
  await execute("drive-check", job, { ...payload, fileId: id })
  return {
    id,
    name: meta.name,
    type: type(meta.mimeType),
    modifiedTime: meta.modifiedTime,
    text: text.slice(0, DRIVE_READ_CHARACTERS),
    truncated: text.length > DRIVE_READ_CHARACTERS,
    untrusted: true,
  }
}

// Knowledge sync -------------------------------------------------------------
const syncRead = z.object({
  sourceId: z.uuid(),
  connectionId: z.uuid(),
  credential: z.string(),
  fileId: z.string(),
  mimeType: z.string(),
  appliedVersion: z.string().nullable(),
  indexed: z.boolean(),
  contentSha256: z.string().nullable(),
  held: z.boolean(),
})
type Embed = (
  texts: string[],
  type: "document",
  job: Lease,
  execute: Execute,
  signal: AbortSignal
) => Promise<number[][]>
/** What a sync did, for the job log: never the file's name or content. */
export type SyncOutcome = "unchanged" | "held" | "published" | "gone" | "reconnect"
/**
 * One check of an imported Drive file. Unchanged versions cost nothing; a
 * change cited by a version in use is held for the curator; a file Drive no
 * longer shares leaves the index; anything else is re-indexed.
 */
export async function syncDriveFile(
  job: Lease,
  execute: Execute,
  config: GoogleConfig | undefined,
  embed: Embed,
  parsePdf: ParsePdf,
  signal: AbortSignal
): Promise<SyncOutcome> {
  if (!config) throw new Error("configuration_required")
  const data = syncRead.parse(await execute("read", job))
  let token: string
  try {
    token = await accessToken(config, data.credential, data.connectionId, async () => {})
  } catch (error) {
    if (error instanceof GoogleError && error.code === "reconnect") {
      await execute("reconnect", job)
      return "reconnect"
    }
    throw new Error("provider_unavailable")
  }
  const gone = async (code: string) => {
    await execute("gone", job, { code })
    return "gone" as const
  }
  let meta: DriveMetadata
  try {
    meta = await fileMetadata(token, data.fileId)
  } catch (error) {
    if (error instanceof DriveFileError) return gone(error.problem)
    if (error instanceof GoogleError && error.code === "reconnect") {
      await execute("reconnect", job)
      return "reconnect"
    }
    throw new Error("provider_unavailable")
  }
  if (meta.mimeType !== data.mimeType) return gone("unsupported")
  const facts = { version: meta.version, modifiedTime: meta.modifiedTime, name: meta.name }
  if (data.indexed && meta.version === data.appliedVersion) {
    await execute("unchanged", job, facts)
    return "unchanged"
  }
  if (data.held) {
    await execute("held", job, facts)
    return "held"
  }
  let read: Awaited<ReturnType<typeof fileText>>
  try {
    read = await fileText(token, meta, parsePdf, signal)
  } catch (error) {
    if (error instanceof DriveFileError) return gone(error.problem)
    if (error instanceof Error && error.message === "invalid_document") throw error
    throw new Error("provider_unavailable")
  }
  const sha = createHash("sha256").update(read.content.bytes).digest("hex")
  // A new Drive version with the same text only moves the version forward.
  if (data.indexed && sha === data.contentSha256) {
    await execute("unchanged", job, facts)
    return "unchanged"
  }
  if (read.content.format === "text") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(read.content.bytes)
    } catch {
      throw new Error("invalid_document")
    }
  }
  const chunks = chunkPages(read.pages)
  if (!chunks.length) throw new Error("invalid_document")
  const embedded: ({ embedding: number[] } & (typeof chunks)[number])[] = []
  for (let start = 0; start < chunks.length; start += 16) {
    await execute("heartbeat", job)
    const batch = chunks.slice(start, start + 16)
    const vectors = await embed(batch.map((c) => c.text), "document", job, execute, signal)
    embedded.push(...batch.map((chunk, index) => ({ ...chunk, embedding: vectors[index]! })))
  }
  const result = await execute("publish", job, {
    ...facts,
    contentSha256: sha,
    parser:
      read.content.format === "pdf"
        ? "pdf-parse-2.4.5"
        : read.content.exported
          ? "drive-export-v1"
          : "text-v1",
    chunks: embedded,
  })
  return result.held === true ? "held" : "published"
}

// Scheduled writes -------------------------------------------------------------
export const scheduledDriveAction = z.object({
  id: z.uuid(),
  token: z.uuid(),
  kind: z.literal("action"),
  lane: z.literal("action"),
  provider: z.literal("drive"),
  queuedAt: z.string().nullable().optional(),
  connectionId: z.uuid(),
  credential: z.string(),
  account: z.string(),
  operation: z.string(),
  argumentsCiphertext: z.string(),
  hash: z.string(),
})
export type ScheduledDriveAction = z.infer<typeof scheduledDriveAction> & Lease
/** Runs one pre-authorized Drive write exactly as proposed; never repeats it. */
export async function runScheduledDriveAction(
  job: ScheduledDriveAction,
  complete: (outcome: string, detail: Record<string, unknown>) => Promise<void>,
  google: GoogleConfig
) {
  let outcome = "failed",
    detail: Record<string, unknown> = { code: "failed" }
  try {
    const call = parseDriveProposal(
      job.operation,
      unseal(job.argumentsCiphertext, `invocation:${job.id}`, google.keys)
    )
    if (digest(JSON.stringify(call.arguments)) !== job.hash) {
      detail = { code: "arguments_changed" }
      return
    }
    let access: string
    try {
      access = await accessToken(google, job.credential, job.connectionId, async () => {})
    } catch (error) {
      // No Drive change was attempted.
      detail = {
        code:
          error instanceof GoogleError && error.code === "reconnect"
            ? "reconnect"
            : "unavailable",
      }
      return
    }
    try {
      const file = await driveWrite(access, call.operation, call.arguments)
      outcome = "succeeded"
      detail = { fileId: file.fileId, name: file.name }
    } catch (error) {
      outcome =
        error instanceof GoogleError && error.code !== "uncertain" ? "failed" : "uncertain"
      detail = { code: error instanceof DriveFileError ? error.problem : outcome }
    }
  } finally {
    await complete(outcome, detail)
  }
}
