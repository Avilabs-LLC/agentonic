import type { WorkspaceView } from "@agentonic/contracts/authoring"

type BadgeVariant =
  | "success"
  | "warning"
  | "error"
  | "orange"
  | "sky"
  | "violet"
  | "emerald"
  | "slate"
  | "pink"
  | "indigo"
  | "teal"

export const submissionBadgeVariants: Record<string, BadgeVariant> = {
  submitted: "warning",
  in_review: "sky",
  changes_requested: "orange",
  rejected: "error",
  withdrawn: "slate",
  approved: "success",
  revoked: "violet",
}

export const agentBadges: Record<
  string,
  { label: string; variant: BadgeVariant }
> = {
  draft: { label: "Borrador", variant: "violet" },
  active: { label: "Activo", variant: "success" },
  paused: { label: "En pausa", variant: "warning" },
  archived: { label: "Archivado", variant: "slate" },
}

// A ready version remains usable during a reprocessing attempt. Otherwise,
// current queued/running work takes precedence over the previous failure.
export function documentBadge(
  document: Pick<
    WorkspaceView["documents"][number],
    "status" | "processingStatus"
  >
): { label: string; variant: BadgeVariant } {
  if (document.status === "ready") return { label: "Listo", variant: "success" }
  if (document.processingStatus === "running")
    return { label: "Procesando", variant: "sky" }
  if (document.processingStatus === "queued")
    return { label: "En cola", variant: "warning" }
  if (document.status === "failed" || document.processingStatus === "failed")
    return { label: "Error", variant: "error" }
  return { label: "Sin procesar", variant: "slate" }
}

// Distinct colors within each state family; the same state uses the same map in both apps.
export const approvalBadgeVariants = {
  unapproved: "slate",
  valid: "success",
  expired: "warning",
  superseded: "violet",
  consent: "pink",
  sources_changed: "orange",
  evidence_expired: "sky",
  authorization_changed: "error",
} satisfies Record<
  import("@agentonic/contracts/lifecycle").LifecycleState["submissions"][number]["reason"],
  BadgeVariant
>

export const deploymentBadgeVariants: Record<string, BadgeVariant> = {
  none: "slate",
  awaiting_activation: "warning",
  queued: "violet",
  preparing: "sky",
  running: "success",
  offline: "orange",
  stopped: "indigo",
  failed: "error",
  superseded: "teal",
  unauthorized: "pink",
}
