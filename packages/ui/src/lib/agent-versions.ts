import type { AgentVersionSummary } from "@agentonic/contracts/agent-versions"
import {
  approvalLabels,
  environmentLabels,
} from "@agentonic/contracts/lifecycle"
import {
  deploymentBadgeVariants,
  statusDescriptor,
  submissionBadgeVariants,
  type BadgeVariant,
  type StatusDescriptor,
} from "@workspace/ui/lib/badge-status"

// Two facets of one agent (architecture §55): the version in use and the next
// one. The row's single badge goes to the version in use when one runs, and
// otherwise to the next version (or Borrador); the other facet is inline.
export type VersionFacet = {
  state: StatusDescriptor | null
  badge: BadgeVariant
  detail: string
  // Further running versions (one per environment); shown inline.
  more: { state: StatusDescriptor; detail: string }[]
  rank: number
}
export type AgentVersionsView = {
  primary: "live" | "next"
  live: VersionFacet
  next: VersionFacet
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
        badge: "slate",
        detail: "Agente archivado",
        more: [],
        rank: liveOrder.length + 1,
      }
    : first
      ? {
          state: deployment(first.status),
          badge: deploymentBadgeVariants[first.status] ?? "slate",
          detail: `Versión ${first.versionNumber} · ${where(first.environment)}${first.resting && first.status === "running" ? " · En reposo" : ""}`,
          more: others.map((l) => ({
            state: deployment(l.status),
            detail: `Versión ${l.versionNumber} · ${where(l.environment)}`,
          })),
          rank: rank(liveOrder, first.status),
        }
      : summary.ended
        ? {
            state: deployment(summary.ended.status),
            badge: deploymentBadgeVariants[summary.ended.status] ?? "slate",
            detail: `Versión ${summary.ended.versionNumber} · ${where(summary.ended.environment)}`,
            more: [],
            rank: rank(liveOrder, summary.ended.status),
          }
        : {
            state: null,
            badge: "slate",
            detail: "Ninguna",
            more: [],
            rank: liveOrder.length + 2,
          }
  const n = summary.next
  let next: VersionFacet
  if (summary.archived || (!n && first))
    next = {
      state: null,
      badge: "slate",
      detail: "Sin propuestas nuevas",
      more: [],
      rank: nextOrder.length + 1,
    }
  else if (!n)
    next = {
      state: statusDescriptor("agent", "draft"),
      badge: "violet",
      detail: "Sin enviar a revisión",
      more: [],
      rank: nextOrder.length + 2,
    }
  else if (n.deployment)
    next = {
      state: deployment(n.deployment.status),
      badge: deploymentBadgeVariants[n.deployment.status] ?? "slate",
      detail: `Versión ${n.versionNumber} · ${where(n.deployment.environment)}`,
      more: [],
      rank: rank(nextOrder, n.deployment.status),
    }
  else if (n.status === "approved" && n.approvalReason !== "valid")
    next = {
      state: statusDescriptor("approval", "invalid"),
      badge: "warning",
      detail: `Versión ${n.versionNumber} · ${approvalLabels[n.approvalReason as keyof typeof approvalLabels] ?? "Sin aprobación"}`,
      more: [],
      rank: rank(nextOrder, "invalid"),
    }
  else
    next = {
      state: statusDescriptor("submission", n.status),
      badge: submissionBadgeVariants[n.status] ?? "slate",
      detail: `Versión ${n.versionNumber}`,
      more: [],
      rank: rank(nextOrder, n.status),
    }
  return {
    primary: summary.archived || first ? "live" : "next",
    live,
    next,
  }
}
