import { z } from "zod"
// Aprender mi estilo (architecture §57): a writing-style guide drafted from the
// mail a person sent from their own connected Gmail account.
const uuid = z.uuid()
export const styleGuideStatus = z.enum([
  "queued",
  "reading",
  "analyzing",
  "writing",
  "ready",
  "accepted",
  "discarded",
  "failed",
  "cancelled",
])
export type StyleGuideStatus = z.infer<typeof styleGuideStatus>
export const activeStyleStatuses: StyleGuideStatus[] = [
  "queued",
  "reading",
  "analyzing",
  "writing",
]
export const STYLE_WINDOW_DAYS = 90
export const STYLE_MAX_MESSAGES = 200
export const STYLE_BUDGET = { min: 0.25, max: 2, default: 0.5 } as const
export const styleGuide = z.object({
  id: uuid,
  connectionId: uuid,
  status: styleGuideStatus,
  messagesRead: z.number().int(),
  messagesTotal: z.number().int().nullable(),
  messagesUsed: z.number().int().nullable(),
  batchesDone: z.number().int(),
  batchesTotal: z.number().int().nullable(),
  budgetUsd: z.coerce.number(),
  committedMicrousd: z.coerce.number(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  expiresAt: z.string().nullable(),
  guide: z.string().nullable(),
  document: z
    .object({
      objectId: uuid,
      title: z.string(),
      collectionId: uuid,
      collection: z.string(),
    })
    .nullable(),
})
export type StyleGuide = z.infer<typeof styleGuide>
export const styleGuideState = z.object({ guides: z.array(styleGuide) })
export const styleMarkdown = z
  .string()
  .trim()
  .min(1, "La guía no puede quedar vacía.")
  .max(40000, "La guía no puede superar los 40.000 caracteres.")
export const styleCommand = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("state"),
      payload: z.object({ agentId: uuid }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("start"),
      payload: z
        .object({
          agentId: uuid,
          connectionId: uuid,
          budgetUsd: z.number().min(STYLE_BUDGET.min).max(STYLE_BUDGET.max),
          consent: z.literal(true),
          requestId: uuid,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.enum(["cancel", "discard"]),
      payload: z.object({ id: uuid }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("accept"),
      payload: z
        .object({ id: uuid, collectionId: uuid, markdown: styleMarkdown })
        .strict(),
    })
    .strict(),
])
export type StyleCommand = z.infer<typeof styleCommand>
/** What went wrong, in words the person can act on. */
export const styleErrors: Record<string, string> = {
  not_enough_mail:
    "No encontramos suficientes correos escritos por ti en los últimos 90 días (hacen falta al menos 5).",
  reconnect:
    "Google pidió volver a conectar la cuenta. Desconéctala y conéctala de nuevo antes de intentarlo.",
  gmail_unavailable:
    "Gmail no está respondiendo en este momento. Inténtalo de nuevo en unos minutos.",
  budget_exhausted:
    "Se alcanzó el límite de gasto autorizado. Inténtalo de nuevo con un límite mayor.",
  provider_unavailable:
    "El análisis no se pudo completar. Inténtalo de nuevo en unos minutos.",
  configuration_required:
    "Agentonic necesita completar su configuración para analizar correos.",
  lease_lost: "El análisis se interrumpió. Inténtalo de nuevo.",
}
export const styleCommandErrors: Record<string, string> = {
  busy: "Ya hay un aprendizaje en curso para esta cuenta.",
  reconnect: "La cuenta necesita volver a conectarse.",
  conflict: "La guía cambió de estado. Vuelve a cargar la página.",
}
