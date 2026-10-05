import { formatUtcMinute as at } from "./format"
import type { LifecycleState } from "./lifecycle"

type Deployment = LifecycleState["deployments"][number]

// Where an activation runs, in words a customer understands. Staff keep
// environmentLabels.
export const customerEnvironmentLabels = {
  azure_staging: "Servidor de pruebas",
  local: "Entorno de desarrollo",
} as const

// An outage on Agentonic's side, such as a service that stopped reporting or
// a server whose verification lapsed. The customer cannot fix it.
export const unavailableOnOurSide =
  "No está disponible por ahora por un problema de nuestro lado. No tienes que hacer nada."

// The state a deployment shows: lost authorization and a silent service
// override the stored status.
export function deploymentDisplayStatus(d: Deployment) {
  if (
    !d.authorized &&
    ["running", "awaiting_activation", "queued", "preparing"].includes(d.status)
  )
    return "unauthorized"
  if (d.status === "running" && !d.online) return "offline"
  return d.status
}

// What the customer can expect from one activation and what, if anything,
// they need to do. Each deadline belongs to whoever renews it: approval and
// consent to the customer, everything else to Agentonic. A reason the
// database does not report is never guessed.
export function customerAvailability(
  d: Deployment,
  state: Pick<LifecycleState, "hosts" | "submissions">,
  now: Date
) {
  const submission = state.submissions.find((s) => s.id === d.submissionId)
  const approved = submission?.reason === "valid"
  const again = approved
    ? "autoriza de nuevo su uso"
    : "renueva la aprobación y autoriza de nuevo su uso"
  const retry = submission?.canAuthorize
    ? " Puedes autorizar de nuevo su uso."
    : ""
  switch (deploymentDisplayStatus(d)) {
    case "running":
      return `Disponible para tus conversaciones hasta el ${at(d.expiresAt)}. Para seguir usándolo después, ${again}.`
    case "offline":
      return `${unavailableOnOurSide} Su uso sigue autorizado hasta el ${at(d.expiresAt)}.`
    case "unauthorized":
      if (Date.parse(d.expiresAt) <= now.getTime())
        return `La autorización de uso terminó el ${at(d.expiresAt)}. Para seguir usándolo, ${again}.`
      if (
        !state.hosts.some((h) => h.environment === d.environment && h.available)
      )
        return unavailableOnOurSide
      return `Esta autorización ya no es válida.${retry}`
    case "awaiting_activation":
      return approved && submission?.expiresAt
        ? `El equipo de Agentonic lo activará; no tienes que hacer nada más. Si no se activa antes del ${at(submission.expiresAt)}, tendrás que renovar la aprobación.`
        : `La aprobación venció antes de la activación. Para usarlo, ${again}.`
    case "queued":
    case "preparing":
      return "Se está activando. Podrás usarlo en tus conversaciones cuando termine."
    case "stopped":
      return `Detenido. Sus conversaciones ya no están disponibles.${retry}`
    case "failed":
      return `No se pudo activar.${retry}`
    case "superseded":
      return "Reemplazado por una activación más reciente."
    default:
      return ""
  }
}

// One line for the agent's header: available until when, temporarily
// unavailable, waiting for activation, or not activated.
export function customerAgentAvailability(
  state: Pick<LifecycleState, "deployments">
) {
  const statuses = state.deployments.map((d) => ({
    d,
    status: deploymentDisplayStatus(d),
  }))
  const live = statuses
    .filter((s) => s.status === "running")
    .map((s) => s.d.expiresAt)
    .sort((a, b) => Date.parse(a) - Date.parse(b))
  if (live.length) return `Disponible hasta el ${at(live.at(-1)!)}`
  if (
    statuses.some(
      (s) =>
        s.status === "offline" ||
        (s.status === "unauthorized" && s.d.status === "running")
    )
  )
    return "No disponible por ahora"
  if (
    statuses.some((s) =>
      ["awaiting_activation", "queued", "preparing"].includes(s.status)
    )
  )
    return "Activación pendiente"
  return "Sin activar"
}
