import { z } from "zod"
import { isSelectableModel, reasoningLevel } from "./models"
import { retrievalResult } from "./rag"
import { turnSteps } from "./turn-steps"
import { previewModel, DEFAULT_PREVIEW_MODEL } from "./preview-models"
const identity = { agentId: z.uuid(), previewId: z.uuid() }
export const previewStartResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id: z.uuid() }),
  z.object({ ok: z.literal(false), code: z.string().optional() }),
])
export const previewCommand = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("start"),
      payload: z
        .object({
          agentId: z.uuid(),
          candidateId: z.uuid(),
          enableTools: z.boolean().optional(),
          budgetUsd: z.union([z.literal(0.25), z.literal(3)]).optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("turn"),
      payload: z
        .object({
          ...identity,
          query: z.string().trim().min(1).max(1000),
          requestKey: z.uuid(),
          model: previewModel
            .refine(isSelectableModel, "Este modelo ya no está disponible.")
            .optional(),
          reasoning: reasoningLevel.nullable().optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("state"),
      payload: z.object(identity).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("cancel"),
      payload: z.object(identity).strict(),
    })
    .strict(),
])
export const previewState = z.object({
  ok: z.literal(true),
  id: z.uuid(),
  expiresAt: z.string(),
  budgetUsd: z.number(),
  gmailEnabled: z.boolean().default(false),
  toolsEnabled: z.boolean().default(false),
  committedMicrousd: z.number(),
  turns: z
    .array(
      retrievalResult.extend({
        id: z.uuid(),
        number: z.number(),
        model: previewModel.default(DEFAULT_PREVIEW_MODEL),
        reasoning: reasoningLevel.nullable().optional(),
        query: z.string().nullable(),
        /** The answer as it is being written, while the turn runs (§68). */
        partial: z.string().nullable().optional(),
        /** What the turn did, step by step (§74); a malformed list shows no steps. */
        steps: turnSteps.nullable().optional().catch(null),
      })
    )
    .max(10),
})
export type PreviewState = z.infer<typeof previewState>
export const previewErrors: Record<string, string> = {
  request_conflict:
    "Este mensaje ya se envió con otro contenido o modelo. Actualiza la conversación antes de continuar.",
  runtime_unavailable:
    "Esta versión todavía no tiene un motor de pruebas disponible. Congela una versión compatible.",
  unavailable:
    "La prueba venció o dejó de estar disponible. Revisa tus permisos y la versión seleccionada.",
  busy: "Espera a que termine la respuesta actual.",
  turn_limit:
    "Esta prueba alcanzó sus 10 mensajes. Finalízala para iniciar otra.",
  rate_limit: "Espera un minuto antes de iniciar otra prueba.",
  budget_exhausted:
    "Se alcanzó el presupuesto de esta prueba o el límite de desarrollo.",
  provider_unavailable:
    "El proveedor de IA rechazó o no respondió la solicitud, así que no se pudo completar la respuesta. No se reintentará automáticamente.",
  configuration_required: "El servicio de pruebas aún no está configurado.",
  lease_lost: "La respuesta se interrumpió o perdió su autorización.",
}
