import { modelConfiguration, modelId, reasoningLevel } from "./models"
import { turnSteps } from "./turn-steps"
import { z } from "zod"
export const approvalReason = z.enum([
  "unapproved",
  "valid",
  "expired",
  "superseded",
  "consent",
  "sources_changed",
  "evidence_expired",
  "authorization_changed",
])
export const approvalLabels: Record<z.infer<typeof approvalReason>, string> = {
  unapproved: "Sin aprobación",
  valid: "Vigente",
  expired: "Vencida",
  superseded: "Revocada o reemplazada",
  consent: "Sin consentimiento vigente",
  sources_changed: "Fuentes modificadas",
  evidence_expired: "Evaluación vencida",
  authorization_changed: "Autorización modificada",
}
export const deploymentLabels: Record<string, string> = {
  none: "Sin despliegue",
  awaiting_activation: "Pendiente de activación",
  queued: "Activación en cola",
  preparing: "Preparando despliegue",
  running: "En funcionamiento",
  // Running, but an account behind one of its Google tools must be reconnected (§84).
  waiting_reconnect: "Esperando reconexión",
  offline: "Sin conexión",
  stopped: "Detenido",
  failed: "No se pudo activar",
  superseded: "Reemplazado",
  unauthorized: "Autorización no vigente",
}
// Staff names for where something runs: the host itself while each
// environment has one. Customers see customerEnvironmentLabels instead.
export const environmentLabels = {
  local: "Local (desarrollo)",
  azure_staging: "vm-agents-01",
}
export const lifecycleState = z.object({
  agentId: z.uuid(),
  hosts: z.array(
    z.object({
      environment: z.enum(["local", "azure_staging"]),
      available: z.boolean(),
    })
  ),
  submissions: z.array(
    z.object({
      id: z.uuid(),
      number: z.number(),
      model: modelId.optional(),
      reasoning: reasoningLevel.nullable().optional(),
      candidateId: z.uuid(),
      versionNumber: z.number(),
      approvalId: z.uuid().nullable(),
      reason: approvalReason,
      expiresAt: z.string().nullable(),
      renewalRequested: z.boolean(),
      renewedSubmissionId: z.uuid().nullable(),
      canRequestRenewal: z.boolean(),
      canRenew: z.boolean(),
      canAuthorize: z.boolean(),
    })
  ),
  deployments: z.array(
    z.object({
      id: z.uuid(),
      submissionId: z.uuid(),
      environment: z.enum(["local", "azure_staging"]),
      status: z.string(),
      authorized: z.boolean(),
      online: z.boolean(),
      /** A Gmail or Drive account behind its tools must be reconnected (§84). */
      waitingGoogle: z.boolean().default(false),
      models: z.array(modelConfiguration).default([]),
      expiresAt: z.string(),
      budgetUsd: z.number(),
      committedMicrousd: z.number(),
      errorCode: z.string().nullable(),
      // Ongoing operating authorization (§59).
      autoRenew: z.boolean().default(false),
      periodBudgetUsd: z.number().nullable().default(null),
      periodStartedAt: z.string().nullable().default(null),
      periodCommittedMicrousd: z.number().default(0),
      renewalBlocked: z.string().nullable().default(null),
      renewsAt: z.string().nullable().default(null),
      renewals: z.number().default(0),
      canChangeRenewal: z.boolean().default(false),
      canRenewNow: z.boolean().default(false),
      canActivate: z.boolean(),
      canStop: z.boolean(),
      canChat: z.boolean(),
    })
  ),
})
export type LifecycleState = z.infer<typeof lifecycleState>
/** A deployment authorizes 30 days at a time, each period with this budget (§59). */
export const DEPLOYMENT_PERIOD_DAYS = 30
export const PERIOD_BUDGET = { min: 1, max: 20, default: 5 } as const
const periodBudget = z
  .number()
  .min(PERIOD_BUDGET.min, "El mínimo es US$1.")
  .max(PERIOD_BUDGET.max, "El máximo es US$20.")
/** Why a running deployment will not renew, in words the customer can act on. */
export const renewalBlockedLabels: Record<string, string> = {
  sources:
    "Cambiaron los documentos que respaldan esta versión. Prepara y evalúa una nueva versión para seguir usándolo.",
  member: "Ya no tienes acceso para editar este agente.",
  approval:
    "La aprobación de esta versión cambió o fue revocada. Revisa Propuestas.",
  revoked: "Detuviste este agente.",
  expired: "La autorización ya terminó.",
  changed:
    "Algo cambió desde la aprobación (la versión, su entorno o tus permisos). Prepara una nueva versión.",
}
export const lifecycleCommand = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("request"),
      payload: z.object({ submissionId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("renew"),
      payload: z
        .object({
          submissionId: z.uuid(),
          budgetUsd: z.number().min(0.05).max(1),
          consent: z.literal(true),
          requestId: z.uuid(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("authorize"),
      payload: z
        .object({
          submissionId: z.uuid(),
          budgetUsd: periodBudget,
          environment: z.enum(["local", "azure_staging"]),
          autoRenew: z.boolean(),
          consent: z.literal(true),
          requestId: z.uuid(),
        })
        .strict(),
    })
    .strict(),
  // Renewal settings, and renewing by hand in the last 10 days (§59).
  z
    .object({
      operation: z.literal("renewal"),
      payload: z
        .object({
          deploymentId: z.uuid(),
          autoRenew: z.boolean(),
          budgetUsd: periodBudget,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("extend"),
      payload: z.object({ deploymentId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.enum(["activate", "stop"]),
      payload: z.object({ deploymentId: z.uuid() }).strict(),
    })
    .strict(),
])
export const chatCommand = z.discriminatedUnion("operation", [
  z
    .object({ operation: z.literal("list"), payload: z.object({}).strict() })
    .strict(),
  z
    .object({
      operation: z.literal("start"),
      payload: z
        .object({
          deploymentId: z.uuid(),
          title: z.string().trim().min(1).max(100),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.enum(["state", "close"]),
      payload: z.object({ conversationId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("turn"),
      payload: z
        .object({
          conversationId: z.uuid(),
          requestId: z.uuid(),
          query: z.string().trim().min(1).max(1000),
          model: modelId.optional(),
          reasoning: reasoningLevel.nullable().optional(),
        })
        .strict(),
    })
    .strict(),
])
export const chatList = z.object({
  ok: z.literal(true),
  conversations: z.array(
    z.object({
      id: z.uuid(),
      agentId: z.uuid(),
      agentName: z.string(),
      deploymentId: z.uuid(),
      title: z.string(),
      expiresAt: z.string(),
    })
  ),
  agents: z.array(
    z.object({
      id: z.uuid(),
      agentId: z.uuid(),
      name: z.string(),
      environment: z.enum(["local", "azure_staging"]),
    })
  ),
})
export const chatState = z.object({
  ok: z.literal(true),
  id: z.uuid(),
  title: z.string(),
  agentId: z.uuid(),
  expiresAt: z.string(),
  /** Messages go to the agent's current, authorized version (§59). */
  canSend: z.boolean().default(true),
  online: z.boolean(),
  models: z.array(modelConfiguration).default([]),
  budgetUsd: z.number(),
  committedMicrousd: z.number(),
  turns: z.array(
    z.object({
      id: z.uuid(),
      number: z.number(),
      /** The version that answered, so a change of version can be shown. */
      version: z.number().nullable().optional(),
      model: modelId.optional(),
      reasoning: reasoningLevel.nullable().optional(),
      query: z.string(),
      answer: z.string().nullable(),
      /** The answer as it is being written, while the turn runs (§68). */
      partial: z.string().nullable().optional(),
      /** What the turn did, step by step (§74); a malformed list shows no steps. */
      steps: turnSteps.nullable().optional().catch(null),
      citations: z.array(z.uuid()),
      status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
      errorCode: z.string().nullable(),
      /** What the turn's paid calls cost, and what still holds unsettled (§82). */
      spentMicrousd: z.number().optional(),
      heldMicrousd: z.number().optional(),
    })
  ),
})
export type ChatState = z.infer<typeof chatState>
export const lifecycleErrors: Record<string, string> = {
  approval_required:
    "La aprobación no está vigente. Renueva la revisión antes de activar.",
  host_unavailable:
    "No se puede activar en este momento por un problema de nuestro lado. Inténtalo más tarde.",
  already_authorized:
    "Esta versión ya tiene una autorización vigente en este servidor. Para cambiar su presupuesto, detenla y vuelve a autorizar.",
  still_valid: "Esta aprobación todavía está vigente.",
  unavailable: "La conversación no está disponible con la autorización actual.",
  offline:
    "El agente no está disponible por ahora por un problema de nuestro lado. Inténtalo más tarde.",
  busy: "Espera a que termine la respuesta anterior.",
  rate_limit: "Has enviado varias solicitudes. Espera un minuto.",
  turn_limit: "Esta conversación alcanzó su límite. Abre una nueva.",
  budget_exhausted:
    "Se alcanzó el límite autorizado. El consumo registrado se conserva.",
  provider_unavailable:
    "El proveedor de IA rechazó o no respondió la solicitud, así que no se pudo completar la respuesta. Inténtalo de nuevo en unos minutos; si se repite, avisa al equipo de Agentonic.",
  lease_lost: "La respuesta se interrumpió. Puedes enviar un nuevo mensaje.",
  runtime_mismatch:
    "No se pudo completar la respuesta por un problema de nuestro lado. Puedes enviar un nuevo mensaje.",
  // §84: Google refused an account behind the agent's tools, or its deployment stopped mid-turn.
  google_reconnect:
    "La autorización de Google de este agente venció. Quien conectó la cuenta debe volver a conectarla en Configuración → Herramientas; el agente retoma al reconectar, sin autorizar de nuevo.",
  deployment_stopped:
    "El agente se detuvo antes de terminar la respuesta. Puedes enviar un nuevo mensaje cuando vuelva a estar disponible.",
  too_early: "Puedes renovar a mano en los últimos 10 días de la autorización.",
  budget_required: "Elige un presupuesto por período antes de renovar.",
  ...renewalBlockedLabels,
}
