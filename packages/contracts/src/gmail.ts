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
const messageShape = {
  to: z.array(address).min(1).max(10),
  cc: z.array(address).max(10),
  bcc: z.array(address).max(10),
  subject: z
    .string()
    .min(1)
    .max(200)
    .refine((s) => !/[\r\n]/.test(s)),
  body: z.string().min(1).max(20000),
}
const recipients = (v: { to: string[]; cc: string[]; bcc: string[] }) =>
  v.to.length + v.cc.length + v.bcc.length <= 10
// A reply names the message it answers; the platform sends it in that
// message's thread with the reply headers (architecture §67).
const replyTo = messageId.describe(
  "Gmail message ID this email answers, from gmail_search or gmail_read: it is sent in that message's thread. null for a new conversation."
)
/** A message a tool call may carry. Earlier calls have no `replyTo`. */
export const gmailMessage = z
  .object({ ...messageShape, replyTo: replyTo.nullable().optional() })
  .strict()
  .refine(recipients)
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
/**
 * The argument schema offered to a model. Strict function schemas need every
 * property, so mailbox-batch runtimes (§67) must give `replyTo`, null for a new
 * conversation, and earlier runtimes are offered the message without it.
 */
export function offeredGmailArguments(
  operation: keyof typeof gmailArguments,
  batch: boolean
) {
  const message = z
    .object(
      batch ? { ...messageShape, replyTo: replyTo.nullable() } : messageShape
    )
    .strict()
    .refine(recipients)
  if (operation === "gmail.drafts.create" || operation === "gmail.send")
    return message
  if (operation === "gmail.drafts.update")
    return z.object({ id: draftId, message }).strict()
  return gmailArguments[operation]
}
/** The message a write carries, wherever its operation keeps it. */
export function gmailWriteMessage(operation: string, args: unknown) {
  const a = args as { message?: unknown } | null
  return operation === "gmail.drafts.update" ? a?.message : args
}
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
