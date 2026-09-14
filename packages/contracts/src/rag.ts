import { z } from "zod"
export const RAG_MODEL = "voyage-4"
export const RAG_DIMENSIONS = 1024
export const ragCommand = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("ingest"),
    payload: z.object({ objectId: z.uuid() }).strict(),
  }),
  z.object({
    operation: z.literal("search"),
    payload: z
      .object({
        query: z.string().trim().min(1).max(1000),
        collectionIds: z.array(z.uuid()).min(1).max(20),
        generateAnswer: z.boolean().default(false),
      })
      .strict(),
  }),
  z.object({
    operation: z.literal("result"),
    payload: z.object({ id: z.uuid() }).strict(),
  }),
])
export const retrievalResult = z.object({
  status: z.enum([
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "unavailable",
  ]),
  error: z.string().nullable().optional(),
  answer: z
    .object({
      text: z.string(),
      citations: z.array(z.uuid()),
      insufficientEvidence: z.boolean(),
      model: z.string(),
    })
    .nullable()
    .optional(),
  matches: z.array(
    z.object({
      id: z.uuid(),
      text: z.string(),
      title: z.string(),
      documentId: z.uuid(),
      objectId: z.uuid(),
      version: z.string(),
      score: z.number(),
      locator: z.object({
        page: z.number().optional(),
        section: z.string().optional(),
        start: z.number().optional(),
        end: z.number().optional(),
      }),
    })
  ),
})
export type RetrievalResult = z.infer<typeof retrievalResult>
export const processingErrors: Record<string, string> = {
  provider_unavailable:
    "El proveedor no está disponible. Se volverá a intentar.",
  budget_exhausted: "Se alcanzó el presupuesto de procesamiento.",
  invalid_document: "No se pudo extraer texto válido de este archivo.",
  ocr_required:
    "Este PDF necesita reconocimiento de texto (OCR). Sube una versión con texto seleccionable.",
  too_much_text:
    "El documento supera el límite de 200 páginas o de texto procesable.",
  storage_unavailable: "No se pudo leer el archivo. Se volverá a intentar.",
  configuration_required:
    "El servicio de procesamiento todavía no está configurado.",
  attempts_exhausted:
    "No se pudo completar el procesamiento. Puedes volver a intentarlo.",
  lease_lost: "El procesamiento fue cancelado o perdió su autorización.",
}
