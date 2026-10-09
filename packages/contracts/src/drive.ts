import { z } from "zod"
// Google Drive (architecture §62): live tools on files a person picked for an
// agent, and knowledge imported from files a curator picked for a collection.
// Only the `drive.file` scope is requested: Google lets the app reach files a
// person picked in the Picker inside Agentonic, and files the app created.
export const DRIVE_FILE_SCOPE = "https://www.googleapis.com/auth/drive.file"
export const driveOperation = z.enum([
  "drive.files.list",
  "drive.files.read",
  "drive.docs.create",
  "drive.docs.update",
])
export type DriveOperation = z.infer<typeof driveOperation>
export const driveReads = ["drive.files.list", "drive.files.read"] as const
export const driveWrites = ["drive.docs.create", "drive.docs.update"] as const
export const driveLabels: Record<DriveOperation, string> = {
  "drive.files.list": "Ver archivos elegidos",
  "drive.files.read": "Leer archivos",
  "drive.docs.create": "Crear documento",
  "drive.docs.update": "Editar documento",
}
/**
 * One Drive account's operations in a version's requested access. Its key is
 * `driveConnectionId`, not Gmail's `connectionId`, so every Gmail reader of a
 * frozen snapshot keeps ignoring it.
 */
export const driveGrant = z
  .object({
    driveConnectionId: z.uuid(),
    operations: z.array(driveOperation).min(1).max(4),
  })
  .strict()
  .refine((v) => new Set(v.operations).size === v.operations.length)
export type DriveGrant = z.infer<typeof driveGrant>

/** Files a person may pick for one agent, and for one knowledge account. */
export const DRIVE_AGENT_FILES = 25
export const DRIVE_KNOWLEDGE_FILES = 50
/** Exported or downloaded content larger than this is refused. */
export const DRIVE_MAX_BYTES = 10 * 1024 * 1024
/** What a read returns to the model; the rest is marked as truncated. */
export const DRIVE_READ_CHARACTERS = 20_000
/** How often a knowledge file is checked for changes. */
export const DRIVE_SYNC_SECONDS = 3600

export const GOOGLE_DOC = "application/vnd.google-apps.document"
export const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet"
export const GOOGLE_SLIDES = "application/vnd.google-apps.presentation"
/** The formats Agentonic reads, and how each is described to a person. */
export const driveTypes: Record<string, string> = {
  [GOOGLE_DOC]: "Documento de Google",
  [GOOGLE_SHEET]: "Hoja de cálculo de Google",
  [GOOGLE_SLIDES]: "Presentación de Google",
  "application/pdf": "PDF",
  "text/plain": "Texto",
  "text/markdown": "Markdown",
}
export const supportedDriveType = (mimeType: string) =>
  Object.hasOwn(driveTypes, mimeType)

// Drive file IDs are URL-safe base64-like strings; a model can't widen scope
// with a URL or a path because nothing else matches.
export const driveFileId = z.string().regex(/^[a-zA-Z0-9_-]{10,200}$/)
const fileId = driveFileId.describe(
  "Google Drive file ID: an id from drive_files_list."
)
const title = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !/[\r\n]/.test(s))
const body = z
  .string()
  .min(1)
  .max(20000)
  .describe("The complete document content, in Markdown.")
/** What the model may ask for. */
export const driveArguments = {
  "drive.files.list": z
    .object({
      name: z
        .string()
        .max(100)
        .describe(
          "Part of a file name to filter by; an empty string lists every file."
        ),
    })
    .strict(),
  "drive.files.read": z.object({ id: fileId }).strict(),
  "drive.docs.create": z
    .object({ title: title.describe("The new document's title."), body })
    .strict(),
  "drive.docs.update": z
    .object({
      id: fileId.describe(
        "Google Drive file ID of a Google Doc from drive_files_list."
      ),
      body: body.describe(
        "The document's complete new content, in Markdown. It replaces everything in the document."
      ),
    })
    .strict(),
} as const
export function parseDriveCall(operation: string, args: unknown) {
  const op = driveOperation.parse(operation)
  return { operation: op, arguments: driveArguments[op].parse(args) }
}
/**
 * What a confirmation is bound to. An update also carries the document's name
 * and the Drive version the broker saw when it was proposed: the platform
 * refuses to run it if the document changed since.
 */
export const driveProposals = {
  "drive.docs.create": driveArguments["drive.docs.create"],
  "drive.docs.update": z
    .object({
      id: driveFileId,
      body: z.string().min(1).max(20000),
      name: z.string().min(1).max(500),
      version: z.string().regex(/^\d{1,20}$/),
    })
    .strict(),
} as const
export type DriveWrite = keyof typeof driveProposals
export function parseDriveProposal(operation: string, args: unknown) {
  const op = z.enum(driveWrites).parse(operation)
  return { operation: op, arguments: driveProposals[op].parse(args) }
}

export const driveFile = z.object({
  fileId: driveFileId,
  name: z.string(),
  mimeType: z.string(),
  origin: z.enum(["picked", "created"]),
  addedAt: z.string(),
})
export type DriveFile = z.infer<typeof driveFile>
const status = z.enum(["connected", "reconnect", "disconnected"])
export const driveConnection = z.object({
  id: z.uuid(),
  account: z.string(),
  status,
  operations: z.array(driveOperation),
  files: z.array(driveFile).default([]),
})
export const driveState = z.object({
  connections: z.array(driveConnection),
  /** Google settings exist on this server. */
  available: z.boolean().optional(),
  /** The Picker's browser key and project number exist on this server. */
  picker: z.boolean().optional(),
})
export type DriveState = z.infer<typeof driveState>
/** What the browser needs to open Google's Picker for one connection. */
export const pickerSession = z.object({
  token: z.string().min(1),
  apiKey: z.string().min(1),
  appId: z.string().regex(/^\d{1,20}$/),
  account: z.string(),
})
export type PickerSession = z.infer<typeof pickerSession>
export const driveInvocation = z.object({
  id: z.uuid(),
  account: z.string(),
  operation: z.enum(driveWrites),
  arguments: z.unknown(),
  hash: z.string(),
  status: z.enum([
    "pending",
    "executing",
    "succeeded",
    "failed",
    "uncertain",
    "cancelled",
    "expired",
  ]),
  expiresAt: z.string(),
  result: z.unknown().optional(),
  automatic: z.boolean().optional(),
})
export type DriveInvocation = z.infer<typeof driveInvocation>

// Knowledge ----------------------------------------------------------------
/** A curator's Drive account for importing files into Conocimiento. */
export const driveKnowledgeConnection = z.object({
  id: z.uuid(),
  account: z.string(),
  status,
  files: z.number().int().nonnegative(),
})
export const driveKnowledgeState = z.object({
  connections: z.array(driveKnowledgeConnection),
  available: z.boolean().optional(),
  picker: z.boolean().optional(),
})
export type DriveKnowledgeState = z.infer<typeof driveKnowledgeState>
/**
 * Where a Drive document stands. `held` means Drive changed but a version in
 * use or awaiting activation cites the current text, so the change waits for
 * its curator; `unavailable` means Drive no longer lets Agentonic read it.
 */
export const driveSyncStatus = z.enum([
  "queued",
  "syncing",
  "synced",
  "held",
  "unavailable",
  "failed",
])
export type DriveSyncStatus = z.infer<typeof driveSyncStatus>
export const driveSyncLabels: Record<DriveSyncStatus, string> = {
  queued: "Sincronización pendiente",
  syncing: "Sincronizando",
  synced: "Sincronizado",
  held: "Cambios en Drive sin aplicar",
  unavailable: "Sin acceso en Drive",
  failed: "No se pudo sincronizar",
}
/** One imported file as Conocimiento shows it; the account only to its owner. */
export const driveKnowledgeFile = z.object({
  sourceId: z.uuid(),
  collectionId: z.uuid(),
  name: z.string(),
  mimeType: z.string(),
  url: z.string().nullable(),
  status: driveSyncStatus,
  errorCode: z.string().nullable(),
  checkedAt: z.string().nullable(),
  syncedAt: z.string().nullable(),
  modifiedAt: z.string().nullable(),
  chunkCount: z.number().int(),
  account: z.string().nullable(),
  connectionStatus: status,
  canManage: z.boolean(),
  citedBy: z.array(z.object({ id: z.uuid(), name: z.string() })),
})
export type DriveKnowledgeFile = z.infer<typeof driveKnowledgeFile>
/** File IDs the Picker returned; each is checked with Drive before it is kept. */
export const pickedFileIds = z.array(driveFileId).min(1).max(50)
/** What a sealed Drive credential holds. */
export const driveCredential = z.object({ refreshToken: z.string().min(1) })
