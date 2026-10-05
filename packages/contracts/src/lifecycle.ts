import { modelConfiguration, modelId, reasoningLevel } from "./models"
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
  offline: "Sin conexión",
  stopped: "Detenido",
  failed: "No se pudo activar",
  superseded: "Reemplazado",
}
export const environmentLabels = {
  local: "Local · desarrollo",
  azure_staging: "VM · pruebas",
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
      models: z.array(modelConfiguration).default([]),
      expiresAt: z.string(),
      budgetUsd: z.number(),
      committedMicrousd: z.number(),
      errorCode: z.string().nullable(),
      canActivate: z.boolean(),
      canStop: z.boolean(),
      canChat: z.boolean(),
    })
  ),
})
export type LifecycleState = z.infer<typeof lifecycleState>
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
          budgetUsd: z.number().min(0.05).max(1),
          environment: z.enum(["local", "azure_staging"]),
          consent: z.literal(true),
          requestId: z.uuid(),
        })
        .strict(),
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
  online: z.boolean(),
  models: z.array(modelConfiguration).default([]),
  budgetUsd: z.number(),
  committedMicrousd: z.number(),
  turns: z.array(
    z.object({
      id: z.uuid(),
      number: z.number(),
      model: modelId.optional(),
      reasoning: reasoningLevel.nullable().optional(),
      query: z.string(),
      answer: z.string().nullable(),
      citations: z.array(z.uuid()),
      status: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]),
      errorCode: z.string().nullable(),
    })
  ),
})
export type ChatState = z.infer<typeof chatState>
export const lifecycleErrors: Record<string, string> = {
  approval_required:
    "La aprobación no está vigente. Renueva la revisión antes de activar.",
  host_unavailable:
    "No se puede activar en este momento por un problema de nuestro lado. Inténtalo más tarde.",
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
    "No se pudo completar la respuesta. El consumo o la reserva pendiente se conserva.",
  lease_lost: "La respuesta se interrumpió. Puedes enviar un nuevo mensaje.",
}
