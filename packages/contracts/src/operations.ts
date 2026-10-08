import { z } from "zod"
import { agentVersionSummary } from "./agent-versions"

// Read models for the Admin operations screens (architecture §52). Metadata
// only: the SQL functions return names, states, counts, times and amounts.
const time = z.string()
const usd = z.coerce.number()
const count = z.coerce.number().int()
const environment = z.enum(["local", "azure_staging"])
const runtime = z.object({ version: z.string(), commit: z.string().nullable() })

export const operationsAgents = z.array(
  z.object({
    id: z.uuid(),
    name: z.string(),
    status: z.string(),
    workspaceId: z.uuid(),
    workspaceName: z.string(),
    ownerName: z.string(),
    createdAt: time,
    // The counted version number ("1"), as text (migration 51).
    latestVersion: z.string().nullable(),
    tools: z.object({
      gmail: z.boolean(),
      web: z.boolean(),
      collections: count,
    }),
    // The saved draft's Recursos, as on the customer list (migration 58).
    resources: z
      .object({
        promptCharacters: count,
        skillsCount: count,
        collectionsCount: count,
        toolsCount: count,
        connectionsCount: count,
      })
      .nullable()
      .default(null),
    deployment: z
      .object({
        status: z.string(),
        environment,
        resting: z.boolean(),
        authorizedUntil: time,
      })
      .nullable(),
    summary: agentVersionSummary,
    lastRunAt: time.nullable(),
    runs7d: count,
  })
)
export type OperationsAgent = z.infer<typeof operationsAgents>[number]

// One agent for the Admin agent page (architecture §55).
export const operationsAgent = z.object({
  id: z.uuid(),
  name: z.string(),
  workspaceId: z.uuid(),
  workspaceName: z.string(),
  ownerName: z.string(),
  createdAt: time,
  latestVersion: count,
  tools: z.object({
    gmail: z.boolean(),
    web: z.boolean(),
    collections: count,
  }),
  summary: agentVersionSummary,
  proposals: z.array(
    z.object({
      id: z.uuid(),
      number: count,
      versionNumber: count,
      status: z.string(),
      submittedAt: time,
      approvalReason: z.string().nullable(),
      approvalExpiresAt: time.nullable(),
    })
  ),
  deployments: z.array(
    z.object({
      id: z.uuid(),
      submissionId: z.uuid(),
      environment,
      status: z.string(),
      resting: z.boolean(),
      versionNumber: count,
      authorizedUntil: time,
      budgetUsd: usd,
      spentUsd: usd,
      createdAt: time,
      activatedAt: time.nullable(),
    })
  ),
  activity: z.object({
    lastRunAt: time.nullable(),
    runs7d: count,
    failed7d: count,
    knownUsd30d: usd,
  }),
})
export type OperationsAgentDetail = z.infer<typeof operationsAgent>

export const operationsActivity = z.object({
  runs: z.object({ succeeded: count, failed: count, active: count }),
  awaitingApproval: count,
  reads24h: count,
  events: z.array(
    z.object({
      id: z.uuid(),
      at: time,
      workspaceName: z.string(),
      action: z.string(),
      resourceType: z.string(),
      resourceId: z.string(),
      outcome: z.string(),
      actor: z.enum(["member", "staff", "system"]),
      agentId: z.uuid().nullable(),
      agentName: z.string().nullable(),
    })
  ),
})
export type OperationsEvent = z.infer<
  typeof operationsActivity
>["events"][number]

export const operationsWorkspaces = z.object({
  workspaces: z.array(
    z.object({
      id: z.uuid(),
      name: z.string(),
      kind: z.string(),
      status: z.string(),
      timezone: z.string(),
      createdAt: time,
      members: count,
      agents: count,
      pendingInvitations: count,
    })
  ),
  staff: z.array(
    z.object({
      name: z.string(),
      role: z.string(),
      status: z.enum(["active", "disabled"]),
      since: time,
    })
  ),
})
export type OperationsWorkspace = z.infer<
  typeof operationsWorkspaces
>["workspaces"][number]

export const operationsDeployments = z.object({
  deployments: z.array(
    z.object({
      id: z.uuid(),
      agentId: z.uuid(),
      agentName: z.string(),
      workspaceName: z.string(),
      environment,
      status: z.string(),
      resting: z.boolean(),
      // Migration 53; optional while an older database is still serving.
      versionNumber: count.optional(),
      broker: z.string().nullable(),
      authorizedUntil: time,
      budgetUsd: usd,
      spentUsd: usd,
      createdAt: time,
      activatedAt: time.nullable(),
    })
  ),
  hosts: z.array(
    z.object({
      environment,
      state: z.string(),
      heartbeatAt: time.nullable(),
      current: z.string(),
      workers: z.array(z.string()),
      runtimes: z.array(runtime),
    })
  ),
  evaluators: z.array(
    z.object({
      environment,
      state: z.string(),
      current: z.string(),
      toolFixtures: z.boolean(),
      runtimes: z.array(runtime),
    })
  ),
})
export type OperationsDeployment = z.infer<
  typeof operationsDeployments
>["deployments"][number]

export const operationsCosts = z.object({
  providers: z.array(
    z.object({
      provider: z.string(),
      capUsd: usd,
      committedUsd: usd,
      settledUsd: usd,
      unknownOperations: count,
    })
  ),
  days: z.array(
    z.object({
      date: z.string(),
      workspaceId: z.uuid(),
      workspaceName: z.string(),
      timezone: z.string(),
      knownUsd: usd,
      unknownOperations: count,
    })
  ),
  agents: z.array(
    z.object({
      agentId: z.uuid().nullable(),
      agentName: z.string(),
      workspaceName: z.string(),
      knownUsd: usd,
      operations: count,
    })
  ),
})
export type OperationsCostDay = z.infer<typeof operationsCosts>["days"][number]

export const operationsReleases = z.array(
  z.object({
    id: z.uuid(),
    version: z.string(),
    commit: z.string(),
    artifact: z.string(),
    status: z.enum(["available", "retired", "revoked"]),
    createdAt: time,
    hosts: z.array(environment),
    evaluators: z.array(environment),
    workspaces: count,
  })
)
export type OperationsRelease = z.infer<typeof operationsReleases>[number]

/** Audit actions in Spanish; an unknown action shows its code. */
export const auditActionLabels: Record<string, string> = {
  "agent.create": "Agente creado",
  "draft.save": "Borrador guardado",
  "candidate.freeze": "Versión congelada",
  "submission.send": "Versión enviada a revisión",
  "upload.reserve": "Carga de documento iniciada",
  "upload.complete": "Documento subido",
  "document.remove": "Documento eliminado",
  "document.download": "Documento descargado",
  "collection.create": "Colección creada",
  "collection.remove": "Colección eliminada",
  "review.open": "Revisión abierta",
  "review.decide": "Revisión decidida",
  "review_flow.prepare": "Criterios en preparación",
  "review_flow.save": "Criterios guardados",
  "review_flow.confirm": "Criterios confirmados",
  "review_flow.run": "Evaluación iniciada",
  "review_flow.cancel": "Evaluación cancelada",
  "evaluation.plan": "Evaluación planificada",
  "evaluation.authorize": "Evaluación autorizada",
  "evaluation.approve": "Evaluación aprobada",
  "evaluation.cancel": "Evaluación cancelada",
  "evaluation.revoke": "Aprobación revocada",
  "approval.renew": "Aprobación renovada",
  "deployment.authorize": "Uso en pruebas autorizado",
  "deployment.activate": "Activación solicitada",
  "deployment.activated": "Despliegue activado",
  "deployment.stop": "Despliegue detenido",
  "deployment.restored": "Copia del agente restaurada",
  "catalog.publish": "Versión del runtime publicada",
  "authoring.denied": "Acceso denegado",
  // Workspace access (architecture §54).
  "member.list": "Miembros consultados",
  "member.update": "Miembro actualizado",
  "invite.list": "Invitaciones consultadas",
  "invite.issue": "Invitación enviada",
  "invite.accept": "Invitación aceptada",
  "invite.revoke": "Invitación retirada",
  "agent.share": "Agente compartido",
  "agent.revoke": "Acceso al agente retirado",
  "collection.share": "Colección compartida",
  "collection.revoke": "Acceso a la colección retirado",
  "maintenance.agent.reset": "Mantenimiento: agente restablecido",
  "maintenance.agent.rename": "Mantenimiento: agente renombrado",
}
export const auditResourceLabels: Record<string, string> = {
  agent: "Agente",
  authoring: "Contenido",
  collection: "Colección",
  submission: "Propuesta",
  evaluation: "Evaluación",
  evaluation_preparation: "Preparación de criterios",
  deployment: "Despliegue",
  code_release: "Versión del runtime",
  workspace: "Espacio de trabajo",
}
export const auditActorLabels = {
  member: "Cliente",
  staff: "Agentonic",
  system: "Sistema",
} as const
export const providerLabels: Record<string, string> = {
  openai: "OpenAI",
  voyage: "Voyage",
  browserbase: "Browserbase",
}
export const workspaceKindLabels: Record<string, string> = {
  organization: "Organización",
  personal: "Personal",
}
export const staffRoleLabels: Record<string, string> = {
  administrator: "Administración",
  operator: "Operación",
  support: "Soporte",
}
