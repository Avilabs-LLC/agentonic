import type { LifecycleState } from "./lifecycle"
import { batchRunning, type ReviewPreparation } from "./review-flow"

export const proposalLabels = {
  in_progress: "En proceso",
  approved: "Aprobada",
  changes_requested: "Requiere cambios",
  needs_attention: "Requiere atención",
  closed: "Cerrada",
}
export type ProposalStatus = keyof typeof proposalLabels

// "Revisión" is the review number in both apps (the submission number Admin
// shows in Revisiones); the criteria's saved edits are "Criterios, edición N".
export function proposalDescriptor(
  version: number | null | undefined,
  review?: number | null,
  criteriaRevision?: number | null
) {
  return [
    `Versión ${version ?? "—"}`,
    ...(review != null ? [`Revisión ${review}`] : []),
    ...(criteriaRevision != null
      ? [`Criterios, edición ${criteriaRevision}`]
      : []),
  ].join(" · ")
}

/** Presentation only. Approval validity and action permissions come from the server. */
export function proposalStatus(
  submissionStatus: string,
  record:
    Pick<ReviewPreparation, "status" | "criteria" | "batches"> | undefined,
  approval: Pick<LifecycleState["submissions"][number], "reason"> | undefined
): ProposalStatus {
  if (
    ["rejected", "withdrawn", "revoked", "superseded"].includes(
      submissionStatus
    ) ||
    record?.status === "revoked"
  )
    return "closed"

  // A historical approval alone does not establish current validity. A rerun
  // belongs in Resultados and must not silently replace the approval decision.
  if (submissionStatus === "approved")
    return approval?.reason === "valid" ? "approved" : "needs_attention"
  if (submissionStatus === "changes_requested") return "changes_requested"
  if (!["submitted", "in_review"].includes(submissionStatus))
    return "needs_attention"
  if (!record) return "in_progress"
  if (["cancelled", "expired"].includes(record.status)) return "needs_attention"

  // Current work supersedes an earlier evaluation's failure, not a decision.
  if (
    ["queued", "preparing"].includes(record.status) ||
    batchRunning(record.batches[0])
  )
    return "in_progress"
  if (record.status === "needs_changes") return "changes_requested"
  if (
    ["error", "needs_attention"].includes(record.status) ||
    !record.criteria.length ||
    record.batches[0]?.models.some((model) =>
      ["error", "cancelled"].includes(model.status)
    )
  )
    return "needs_attention"
  return "in_progress"
}
