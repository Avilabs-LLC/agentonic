import type { AgentVersionSummary } from "@agentonic/contracts/agent-versions"
import { environmentLabels } from "@agentonic/contracts/lifecycle"
import {
  statusDescriptor,
  type StatusDescriptor,
} from "@workspace/ui/lib/badge-status"

// Two facets of one agent (architecture §55): the version in use and the next
// one. Tables show the version in use's state as the row's badge (Despliegue)
// and each facet's facts as labelled fields; tiles use `detail`.
export type VersionFacet = {
  state: StatusDescriptor | null
  detail: string
  versionNumber: number | null
  place: string | null
  // Further running versions (one per environment).
  more: { state: StatusDescriptor; detail: string }[]
  rank: number
}
export type AgentVersionsView = {
  live: VersionFacet
  next: VersionFacet
  // Whether the version in use rests; null when it is not running.
  resting: boolean | null
}

const liveOrder = ["running", "offline", "unauthorized", "stopped", "failed"]
const nextOrder = [
  "awaiting_activation",
  "queued",
  "preparing",
  "unauthorized",
  "approved",
  "invalid",
  "in_review",
  "submitted",
  "changes_requested",
  "rejected",
  "revoked",
]
type Places = Record<keyof typeof environmentLabels, string>
const deployment = (status: string) => statusDescriptor("deployment", status)
const rank = (order: string[], key: string) => {
  const index = order.indexOf(key)
  return index === -1 ? order.length : index
}

// Staff see the host (environmentLabels); customers pass
// customerEnvironmentLabels.
export function agentVersionsView(
  summary: AgentVersionSummary,
  places: Places = environmentLabels
): AgentVersionsView {
  const where = (environment: keyof Places) => places[environment]
  const [first, ...others] = summary.live
  const live: VersionFacet = summary.archived
    ? {
        state: statusDescriptor("agent", "archived"),
        detail: "Agente archivado",
        versionNumber: null,
        place: null,
        more: [],
        rank: liveOrder.length + 1,
      }
    : first
      ? {
          state: deployment(first.status),
          detail: `Versión ${first.versionNumber} · ${where(first.environment)}`,
          versionNumber: first.versionNumber,
          place: where(first.environment),
          more: others.map((l) => ({
            state: deployment(l.status),
            detail: `Versión ${l.versionNumber} · ${where(l.environment)}`,
          })),
          rank: rank(liveOrder, first.status),
        }
      : summary.ended
        ? {
            state: deployment(summary.ended.status),
            detail: `Versión ${summary.ended.versionNumber} · ${where(summary.ended.environment)}`,
            versionNumber: summary.ended.versionNumber,
            place: where(summary.ended.environment),
            more: [],
            rank: rank(liveOrder, summary.ended.status),
          }
        : {
            state: null,
            detail: "Ninguna",
            versionNumber: null,
            place: null,
            more: [],
            rank: liveOrder.length + 2,
          }
  const n = summary.next
  let next: VersionFacet
  if (summary.archived || (!n && first))
    next = {
      state: null,
      detail: "Sin propuestas nuevas",
      versionNumber: null,
      place: null,
      more: [],
      rank: nextOrder.length + 1,
    }
  else if (!n)
    next = {
      state: statusDescriptor("agent", "draft"),
      detail: "Sin enviar a revisión",
      versionNumber: null,
      place: null,
      more: [],
      rank: nextOrder.length + 2,
    }
  else if (n.deployment)
    next = {
      state: deployment(n.deployment.status),
      detail: `Versión ${n.versionNumber} · ${where(n.deployment.environment)}`,
      versionNumber: n.versionNumber,
      place: where(n.deployment.environment),
      more: [],
      rank: rank(nextOrder, n.deployment.status),
    }
  else if (n.status === "approved" && n.approvalReason !== "valid")
    next = {
      state: statusDescriptor("approval", n.approvalReason ?? "unapproved"),
      detail: `Versión ${n.versionNumber}`,
      versionNumber: n.versionNumber,
      place: null,
      more: [],
      rank: rank(nextOrder, "invalid"),
    }
  else
    next = {
      state: statusDescriptor("submission", n.status),
      detail: `Versión ${n.versionNumber}`,
      versionNumber: n.versionNumber,
      place: null,
      more: [],
      rank: rank(nextOrder, n.status),
    }
  return {
    live,
    next,
    resting:
      !summary.archived && first?.status === "running" ? first.resting : null,
  }
}
