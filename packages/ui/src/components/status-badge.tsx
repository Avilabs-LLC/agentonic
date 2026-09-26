import {
  submissionLabels,
  type WorkspaceView,
} from "@agentonic/contracts/authoring"
import { Badge } from "@workspace/ui/components/badge"
import {
  proposalLabels,
  type ProposalStatus,
} from "@agentonic/contracts/proposals"
import {
  agentBadges,
  documentBadge,
  submissionBadgeVariants,
  proposalBadgeVariants,
} from "@workspace/ui/lib/badge-status"

export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  return (
    <Badge variant={proposalBadgeVariants[status]}>
      {proposalLabels[status]}
    </Badge>
  )
}

export function AgentStatusBadge({ status }: { status: string }) {
  const badge = agentBadges[status]
  return (
    <Badge variant={badge?.variant ?? "slate"}>
      {badge?.label ?? "Estado desconocido"}
    </Badge>
  )
}

export function SubmissionStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant={submissionBadgeVariants[status] ?? "slate"}>
      {submissionLabels[status] ?? "Estado desconocido"}
    </Badge>
  )
}

export function DocumentStatusBadge({
  document,
}: {
  document: Pick<
    WorkspaceView["documents"][number],
    "status" | "processingStatus"
  >
}) {
  const badge = documentBadge(document)
  return <Badge variant={badge.variant}>{badge.label}</Badge>
}
