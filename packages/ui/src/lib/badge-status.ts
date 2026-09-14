import type { VariantProps } from "class-variance-authority"
import type { WorkspaceView } from "@agentonic/contracts/authoring"
import type { badgeVariants } from "@workspace/ui/components/badge"

type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>

export const submissionBadgeVariants: Record<string, BadgeVariant> = {
  submitted: "warning",
  in_review: "sky",
  changes_requested: "orange",
  rejected: "error",
  withdrawn: "slate",
  approved: "success",
  revoked: "error",
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
