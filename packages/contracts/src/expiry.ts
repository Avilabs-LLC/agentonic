import { z } from "zod"
import type { ReviewListing } from "./authoring"

const environment = z.enum(["local", "azure_staging"])
export const registrationState = z.enum([
  "valid",
  "expiring",
  "expired",
  "revoked",
  "retired",
])
export type RegistrationState = z.infer<typeof registrationState>
const registration = z.object({
  environment,
  verifiedAt: z.string(),
  expiresAt: z.string(),
  state: registrationState,
})
export type Registration = z.infer<typeof registration>
export const runtimeRegistrations = z.object({
  hosts: z.array(registration),
  evaluators: z.array(registration),
})
export type RuntimeRegistrations = z.infer<typeof runtimeRegistrations>

// Plain-language names: what each registration lets Agentonic run.
export const registrationNames = {
  host: {
    azure_staging: "Agentes en vm-agents-01",
    local: "Agentes en local (desarrollo)",
  },
  evaluator: {
    azure_staging: "Evaluaciones en vm-agents-01",
    local: "Evaluaciones en local (desarrollo)",
  },
} as const

export type ExpiryActor = "customer" | "staff"
export const expiryActorLabels: Record<ExpiryActor, string> = {
  customer: "Cliente",
  staff: "Equipo de Agentonic",
}
export type NextStep = {
  actor: ExpiryActor | null
  action: string
  by: string | null
}
export type ExpiryRow = {
  id: string
  workspaceId: string
  workspaceName: string
  agentId: string | null
  agentName: string
  versionNumber: number
  status: string
  environment: z.infer<typeof environment> | null
  approvalExpiresAt: string | null
  approvalValid: boolean
  consentExpiresAt: string | null
  host: Registration | null
  next: NextStep
}

const activeDeployment = [
  "awaiting_activation",
  "queued",
  "preparing",
  "running",
  "offline",
]
const time = (value: string | null) =>
  value === null ? Infinity : Date.parse(value)
const earliest = (...values: (string | null)[]) =>
  values.reduce((first, value) => (time(value) < time(first) ? value : first))

// The next deadline and who acts on it. Each deadline keeps its own owner:
// the customer renews approval and operating consent, the team renews server
// verification. Reasons the database does not report are never guessed.
export function nextStep(row: Omit<ExpiryRow, "next">, now: Date): NextStep {
  // A new authorization needs a valid approval; otherwise renewal comes first.
  const renewApproval: NextStep = {
    actor: "customer",
    action: "Renovar la aprobación",
    by: null,
  }
  const authorize = (action: string): NextStep =>
    row.approvalValid
      ? { actor: "customer", action, by: row.approvalExpiresAt }
      : renewApproval
  const host: NextStep = {
    actor: "staff",
    action: "Renovar la verificación del servidor",
    by: row.host?.expiresAt ?? null,
  }
  if (!activeDeployment.includes(row.status) && row.status !== "unauthorized")
    return authorize("Autorizar el uso de pruebas")
  if (!row.host || ["expired", "revoked"].includes(row.host.state)) return host
  if (row.status === "unauthorized")
    return time(row.consentExpiresAt) <= now.getTime()
      ? authorize("Autorizar de nuevo el uso de pruebas")
      : { actor: "staff", action: "Revisar el comprobante", by: null }
  if (row.status === "awaiting_activation")
    return row.approvalValid
      ? {
          actor: "staff",
          action: "Activar la versión",
          by: earliest(
            row.approvalExpiresAt,
            row.consentExpiresAt,
            row.host.expiresAt
          ),
        }
      : renewApproval
  // Installation must finish while the approval is still valid.
  if (row.status === "queued" || row.status === "preparing")
    return {
      actor: null,
      action: "Instalación en curso",
      by: row.approvalExpiresAt,
    }
  if (row.status === "offline")
    return {
      actor: "staff",
      action: "Revisar el agente sin conexión",
      by: null,
    }
  // Running: whichever lapses first stops the agent.
  return time(row.consentExpiresAt) < time(row.host.expiresAt)
    ? {
        actor: "customer",
        action: row.approvalValid
          ? "Autorizar de nuevo para seguir usándolo"
          : "Renovar la aprobación para seguir usándolo",
        by: row.consentExpiresAt,
      }
    : host
}

// Rows needing attention now (an action with no deadline) come first, then
// the nearest deadline.
const order = (step: NextStep) =>
  step.by !== null
    ? Date.parse(step.by)
    : step.actor === null
      ? Infinity
      : -Infinity

// Approved versions with something still to expire: a valid approval not yet
// in use, or a deployment that is pending or running.
export function expiryRows(
  reviews: ReviewListing,
  registrations: RuntimeRegistrations,
  now: Date
): ExpiryRow[] {
  return reviews
    .filter(
      (review) =>
        review.status === "approved" &&
        (review.approvalReason === "valid" ||
          activeDeployment.includes(review.deploymentStatus ?? "none"))
    )
    .map((review) => {
      const deployed =
        activeDeployment.includes(review.deploymentStatus ?? "none") &&
        review.deploymentEnvironment !== undefined
      const status =
        deployed && review.deploymentAuthorized === false
          ? "unauthorized"
          : (review.deploymentStatus ?? "none")
      const row = {
        id: review.id,
        workspaceId: review.workspaceId,
        workspaceName: review.workspaceName,
        agentId: review.agentId ?? null,
        agentName: review.agentName,
        versionNumber: review.versionNumber,
        status,
        environment: deployed ? review.deploymentEnvironment! : null,
        approvalExpiresAt: review.approvalExpiresAt ?? null,
        approvalValid: review.approvalReason === "valid",
        consentExpiresAt: deployed ? (review.consentExpiresAt ?? null) : null,
        host: deployed
          ? (registrations.hosts.find(
              (h) => h.environment === review.deploymentEnvironment
            ) ?? null)
          : null,
      }
      return { ...row, next: nextStep(row, now) }
    })
    .sort(
      (a, b) =>
        Math.sign(order(a.next) - order(b.next) || 0) ||
        a.agentName.localeCompare(b.agentName, "es")
    )
}
