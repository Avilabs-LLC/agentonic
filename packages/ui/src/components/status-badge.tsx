import {
  proposalLabels,
  type ProposalStatus,
} from "@agentonic/contracts/proposals"
import { proposalBadgeVariants } from "@workspace/ui/lib/badge-status"
import {
  ActivityIcon,
  ArchiveIcon,
  BanIcon,
  CheckIcon,
  CircleHelpIcon,
  Clock3Icon,
  MinusIcon,
  PauseIcon,
  PencilIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import type { WorkspaceView } from "@agentonic/contracts/authoring"
import type { ReviewCriterion } from "@agentonic/contracts/review-flow"
import { cn } from "@workspace/ui/lib/utils"
import { Badge } from "@workspace/ui/components/badge"
import {
  criterionStatus,
  documentBadge,
  statusDescriptor,
  type StatusDescriptor,
  type StatusDomain,
  type StatusTone,
} from "@workspace/ui/lib/badge-status"

const icons = {
  activity: ActivityIcon,
  archive: ArchiveIcon,
  ban: BanIcon,
  check: CheckIcon,
  clock: Clock3Icon,
  help: CircleHelpIcon,
  minus: MinusIcon,
  pause: PauseIcon,
  pencil: PencilIcon,
  alert: TriangleAlertIcon,
  x: XIcon,
}
// Centralized status palette for unboxed indicators. Text remains neutral except for exceptions.
const iconTones: Record<StatusTone, string> = {
  success: "text-emerald-700 dark:text-emerald-300",
  warning: "text-yellow-800 dark:text-yellow-300",
  error: "text-red-700 dark:text-red-300",
  orange: "text-orange-800 dark:text-orange-300",
  sky: "text-sky-700 dark:text-sky-300",
  violet: "text-violet-700 dark:text-violet-300",
  slate: "text-muted-foreground",
}
export function StatusIndicator({
  state,
  appearance = "inline",
  className,
}: {
  state: StatusDescriptor
  appearance?: "badge" | "inline"
  className?: string
}) {
  const Icon = icons[state.icon]
  if (appearance === "badge")
    return (
      <Badge
        variant={state.variant}
        className={cn(
          "h-auto min-h-5 max-w-full justify-start text-left whitespace-normal",
          className
        )}
      >
        <Icon
          aria-hidden="true"
          data-icon="inline-start"
          className="shrink-0"
        />
        <span>{state.label}</span>
      </Badge>
    )
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground",
        className
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-3.5 shrink-0", iconTones[state.variant])}
      />
      <span
        className={cn(
          "min-w-0",
          ["error", "warning", "orange"].includes(state.variant) &&
            "font-medium text-foreground"
        )}
      >
        {state.label}
      </span>
    </span>
  )
}
export function DomainStatus({
  domain,
  status,
  appearance,
  className,
}: {
  domain: StatusDomain
  status: string
  appearance?: "badge" | "inline"
  className?: string
}) {
  return (
    <StatusIndicator
      state={statusDescriptor(domain, status)}
      appearance={appearance}
      className={className}
    />
  )
}
export function CriterionStatus({
  criterion,
  confirmed = false,
}: {
  criterion: ReviewCriterion
  confirmed?: boolean
}) {
  return <StatusIndicator state={criterionStatus(criterion, confirmed)} />
}
export function AgentStatusBadge({ status }: { status: string }) {
  return <DomainStatus domain="agent" status={status} appearance="badge" />
}
export function SubmissionStatusBadge({ status }: { status: string }) {
  return <DomainStatus domain="submission" status={status} appearance="badge" />
}
export function DocumentStatusBadge({
  document,
}: {
  document: Pick<
    WorkspaceView["documents"][number],
    "status" | "processingStatus"
  >
}) {
  return <StatusIndicator state={documentBadge(document)} appearance="badge" />
}

export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  return (
    <Badge variant={proposalBadgeVariants[status]}>
      {proposalLabels[status]}
    </Badge>
  )
}
