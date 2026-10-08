import { z } from "zod"
import { styleGuide } from "./style-guide"
export const gmailOperation = z.enum([
  "gmail.search",
  "gmail.read",
  "gmail.drafts.list",
  "gmail.drafts.read",
  "gmail.drafts.create",
  "gmail.drafts.update",
  "gmail.drafts.delete",
  "gmail.send",
])
export const gmailReads = [
  "gmail.search",
  "gmail.read",
  "gmail.drafts.list",
  "gmail.drafts.read",
] as const
export const gmailWrites = [
  "gmail.drafts.create",
  "gmail.drafts.update",
  "gmail.drafts.delete",
  "gmail.send",
] as const
export const gmailLabels: Record<string, string> = {
  "gmail.search": "Buscar correos",
  "gmail.read": "Leer correos",
  "gmail.drafts.list": "Listar borradores",
  "gmail.drafts.read": "Leer borradores",
  "gmail.drafts.create": "Crear borrador",
  "gmail.drafts.update": "Editar borrador",
  "gmail.drafts.delete": "Eliminar borrador",
  "gmail.send": "Enviar correo",
}
export const gmailGrant = z
  .object({
    connectionId: z.uuid(),
    operations: z.array(gmailOperation).min(1).max(8),
  })
  .strict()
  .refine((v) => new Set(v.operations).size === v.operations.length)
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
// A draft has its own ID and wraps a message with another; the model was seen
// editing a draft by its message ID, which Gmail rejects (B2, 8 October).
const messageId = id.describe("Gmail message ID: an id from gmail_search.")
const draftId = id.describe(
  "Gmail draft ID: a draftId from gmail_drafts_list or gmail_drafts_read. Never a messageId."
)
const address = z
  .email()
  .max(254)
  .refine((s) => !/[\r\n]/.test(s))
export const gmailMessage = z
  .object({
    to: z.array(address).min(1).max(10),
    cc: z.array(address).max(10),
    bcc: z.array(address).max(10),
    subject: z
      .string()
      .min(1)
      .max(200)
      .refine((s) => !/[\r\n]/.test(s)),
    body: z.string().min(1).max(20000),
  })
  .strict()
  .refine((v) => v.to.length + v.cc.length + v.bcc.length <= 10)
export const gmailArguments = {
  "gmail.search": z
    .object({
      query: z.string().max(500),
      limit: z.number().int().min(1).max(10),
    })
    .strict(),
  "gmail.read": z.object({ id: messageId }).strict(),
  "gmail.drafts.list": z
    .object({ limit: z.number().int().min(1).max(10) })
    .strict(),
  "gmail.drafts.read": z.object({ id: draftId }).strict(),
  "gmail.drafts.create": gmailMessage,
  "gmail.drafts.update": z
    .object({ id: draftId, message: gmailMessage })
    .strict(),
  "gmail.drafts.delete": z.object({ id: draftId }).strict(),
  "gmail.send": gmailMessage,
} as const
export function parseGmailCall(operation: string, args: unknown) {
  const op = gmailOperation.parse(operation)
  return { operation: op, arguments: gmailArguments[op].parse(args) }
}
export const gmailConnection = z.object({
  id: z.uuid(),
  account: z.string(),
  status: z.enum(["connected", "reconnect", "disconnected"]),
  operations: z.array(gmailOperation),
})
export const gmailState = z.object({
  connections: z.array(gmailConnection),
  available: z.boolean().optional(),
  /** The latest Aprender mi estilo guide of each of the member's accounts (§57). */
  styleGuides: z.array(styleGuide).default([]),
})
export type GmailState = z.infer<typeof gmailState>
export const gmailInvocation = z.object({
  id: z.uuid(),
  account: z.string(),
  operation: gmailOperation,
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
})
export type GmailInvocation = z.infer<typeof gmailInvocation>
