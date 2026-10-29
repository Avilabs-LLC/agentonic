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
  // Runtime 0.7.0 and later (§68); needs the gmail.modify scope.
  "gmail.labels.apply",
])
/**
 * What a model may call: the grantable operations, plus reading a whole
 * thread, which the read grant covers (§68).
 */
export const gmailToolOperation = z.enum([
  ...gmailOperation.options,
  "gmail.threads.read",
])
export const gmailReads = [
  "gmail.search",
  "gmail.read",
  "gmail.drafts.list",
  "gmail.drafts.read",
  "gmail.threads.read",
] as const
export const gmailWrites = [
  "gmail.drafts.create",
  "gmail.drafts.update",
  "gmail.drafts.delete",
  "gmail.send",
  "gmail.labels.apply",
] as const
/** The grant a tool needs: a thread is read under the read grant. */
export const gmailGrantFor = (operation: string) =>
  operation === "gmail.threads.read" ? "gmail.read" : operation
export const gmailLabels: Record<string, string> = {
  "gmail.search": "Buscar correos",
  "gmail.read": "Leer correos",
  "gmail.drafts.list": "Listar borradores",
  "gmail.drafts.read": "Leer borradores",
  "gmail.drafts.create": "Crear borrador",
  "gmail.drafts.update": "Editar borrador",
  "gmail.drafts.delete": "Eliminar borrador",
  "gmail.send": "Enviar correo",
  "gmail.labels.apply": "Aplicar etiquetas",
  "gmail.threads.read": "Leer hilos",
}
export const gmailGrant = z
  .object({
    connectionId: z.uuid(),
    operations: z.array(gmailOperation).min(1).max(9),
  })
  .strict()
  .refine((v) => new Set(v.operations).size === v.operations.length)
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
// A draft has its own ID and wraps a message with another; the model was seen
// editing a draft by its message ID, which Gmail rejects (B2, 8 October).
const messageId = id.describe("Gmail message ID: an id from gmail_search.")
const threadId = id.describe(
  "Gmail thread ID: a threadId from gmail_search or gmail_read."
)
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
// What the owner should check before confirming one message (runtime 0.9.0,
// §81). It shows in the message's card and is never sent.
const note = z
  .string()
  .max(500)
  .describe(
    "A short note for the owner about this message, in their language: what to check before confirming it, such as an assumption, a fact you could not verify or a blank to fill in. null when there is nothing to flag. Never repeat the message here."
  )
/** A message a tool call may carry. Earlier calls have no `replyTo` or `note`. */
export const gmailMessage = z
  .object({
    ...messageShape,
    replyTo: replyTo.nullable().optional(),
    note: note.nullable().optional(),
  })
  .strict()
  .refine(recipients)
// Gmail's own labels, which would move or flag mail, are never applied (§68).
const systemLabels =
  /^(inbox|spam|trash|unread|starred|important|sent|draft|chat|category_.*)$/i
const labelName = z
  .string()
  .min(1)
  .max(100)
  .refine((s) => !/[\r\n]/.test(s) && s.trim() === s && !systemLabels.test(s))
  .describe("The label's name, created if the mailbox lacks it.")
/** One proposal labels a batch; each item names the subject the agent read, checked before applying. */
const labelItem = z
  .object({
    messageId,
    subject: z
      .string()
      .max(200)
      .refine((s) => !/[\r\n]/.test(s))
      .describe(
        "The message's subject exactly as read; the platform checks it."
      ),
    label: labelName,
  })
  .strict()
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
  "gmail.threads.read": z.object({ id: threadId }).strict(),
  "gmail.labels.apply": z
    .object({ labels: z.array(labelItem).min(1).max(10) })
    .strict(),
} as const
/**
 * The argument schema offered to a model. Strict function schemas need every
 * property, so mailbox-batch runtimes (§67) must give `replyTo`, null for a new
 * conversation, and earlier runtimes are offered the message without it.
 * Runtimes that declare `draftNotes` (0.9.0, §81) must also give `note`.
 */
export function offeredGmailArguments(
  operation: keyof typeof gmailArguments,
  batch: boolean,
  notes = false
) {
  const message = z
    .object(
      batch
        ? {
            ...messageShape,
            replyTo: replyTo.nullable(),
            ...(notes ? { note: note.nullable() } : {}),
          }
        : messageShape
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
  const op = gmailToolOperation.parse(operation)
  return { operation: op, arguments: gmailArguments[op].parse(args) }
}
export const gmailConnection = z.object({
  id: z.uuid(),
  account: z.string(),
  status: z.enum(["connected", "reconnect", "disconnected"]),
  operations: z.array(gmailOperation),
  /** Connected with gmail.modify, so labels can be applied (§68). */
  canLabel: z.boolean().default(false),
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
/**
 * The conversation a proposed reply answers, as its card shows it (§81):
 * plain text, oldest first, read from Gmail when the card opens.
 */
export const gmailThreadView = z.object({
  messages: z
    .array(
      z.object({
        id: z.string(),
        from: z.string(),
        to: z.string(),
        cc: z.string(),
        subject: z.string(),
        date: z.string(),
        text: z.string(),
        /** The message the reply answers. */
        answered: z.boolean(),
      })
    )
    .max(10),
  /** Earlier messages of a longer thread, not shown. */
  earlierMessages: z.number().int().min(0),
})
export type GmailThreadView = z.infer<typeof gmailThreadView>
