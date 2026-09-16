import {
  submissionLabels,
  type WorkspaceView,
} from "@agentonic/contracts/authoring"
import { evaluationStatus } from "@agentonic/contracts/evaluation"
import {
  reviewFlowLabels,
  type ReviewCriterion,
} from "@agentonic/contracts/review-flow"

export type StatusTone =
  "success" | "warning" | "error" | "orange" | "sky" | "violet" | "slate"
export type StatusIcon =
  | "check"
  | "clock"
  | "activity"
  | "alert"
  | "x"
  | "ban"
  | "pause"
  | "archive"
  | "pencil"
  | "minus"
  | "help"
export type StatusDescriptor = {
  label: string
  variant: StatusTone
  icon: StatusIcon
}
const state = (
  label: string,
  variant: StatusTone,
  icon: StatusIcon
): StatusDescriptor => ({ label, variant, icon })
export const unknownStatus = state("Estado desconocido", "slate", "help")

export const statusMaps = {
  agent: {
    draft: state("Borrador", "violet", "pencil"),
    active: state("Activo", "success", "check"),
    paused: state("En pausa", "warning", "pause"),
    archived: state("Archivado", "slate", "archive"),
  },
  submission: {
    submitted: state(submissionLabels.submitted!, "warning", "clock"),
    in_review: state(submissionLabels.in_review!, "sky", "activity"),
    changes_requested: state(
      submissionLabels.changes_requested!,
      "orange",
      "pencil"
    ),
    rejected: state(submissionLabels.rejected!, "error", "x"),
    withdrawn: state(submissionLabels.withdrawn!, "slate", "minus"),
    approved: state(submissionLabels.approved!, "success", "check"),
    revoked: state(submissionLabels.revoked!, "error", "ban"),
  },
  review: {
    queued: state(reviewFlowLabels.queued, "warning", "clock"),
    preparing: state(reviewFlowLabels.preparing, "sky", "activity"),
    criteria_ready: state(reviewFlowLabels.criteria_ready, "warning", "pencil"),
    evaluating: state(reviewFlowLabels.evaluating, "sky", "activity"),
    approved: state(reviewFlowLabels.approved, "success", "check"),
    needs_changes: state(reviewFlowLabels.needs_changes, "orange", "pencil"),
    needs_attention: state(
      reviewFlowLabels.needs_attention,
      "warning",
      "alert"
    ),
    error: state(reviewFlowLabels.error, "error", "x"),
    cancelled: state(reviewFlowLabels.cancelled, "slate", "minus"),
    revoked: state(reviewFlowLabels.revoked, "error", "ban"),
    expired: state(reviewFlowLabels.expired, "warning", "clock"),
  } satisfies Record<keyof typeof reviewFlowLabels, StatusDescriptor>,
  evaluation: {
    awaiting_consent: state(
      evaluationStatus.awaiting_consent,
      "warning",
      "clock"
    ),
    queued: state(evaluationStatus.queued, "warning", "clock"),
    running: state(evaluationStatus.running, "sky", "activity"),
    passed: state(evaluationStatus.passed, "success", "check"),
    failed: state(evaluationStatus.failed, "error", "x"),
    error: state(evaluationStatus.error, "error", "alert"),
    cancelled: state(evaluationStatus.cancelled, "slate", "minus"),
  } satisfies Record<keyof typeof evaluationStatus, StatusDescriptor>,
  result: {
    passed: state("Superada", "success", "check"),
    failed: state("No superada", "error", "x"),
    needs_attention: state("Requiere atención", "warning", "alert"),
  },
  approval: {
    valid: state("Aprobación vigente", "success", "check"),
    invalid: state("Aprobación no vigente", "warning", "alert"),
  },
}
export type StatusDomain = keyof typeof statusMaps
export function statusDescriptor(
  domain: StatusDomain,
  status: string
): StatusDescriptor {
  const map: Record<string, StatusDescriptor> = statusMaps[domain]
  return Object.hasOwn(map, status) ? map[status]! : unknownStatus
}

// Closed submission decisions override earlier review evidence; otherwise use the
// review read model, which includes current expiry and revocation checks.
export function proposalStatus(
  submission: string,
  review?: string
): StatusDescriptor {
  if (
    ["revoked", "rejected", "withdrawn", "changes_requested"].includes(
      submission
    )
  )
    return statusDescriptor("submission", submission)
  if (review) return statusDescriptor("review", review)
  if (submission === "approved")
    return state("Aprobación registrada", "slate", "check")
  return statusDescriptor("submission", submission)
}

// Criterion acceptance is a customer decision, never an evaluation pass.
export function criterionStatus(
  criterion: ReviewCriterion,
  confirmed = false
): StatusDescriptor {
  if (
    criterion.reviewDecision === "not_applicable" ||
    (confirmed && criterion.excluded)
  )
    return state("No aplica", "slate", "minus")
  if (criterion.reviewDecision === "approved")
    return state("Aprobada por el cliente", "slate", "check")
  if (confirmed) return state("Confirmada", "slate", "check")
  return state("Pendiente", "warning", "clock")
}

// A ready version remains usable during reprocessing. Active work precedes an old failure.
export function documentBadge(
  document: Pick<
    WorkspaceView["documents"][number],
    "status" | "processingStatus"
  >
): StatusDescriptor {
  if (document.status === "ready") return state("Listo", "success", "check")
  if (document.processingStatus === "running")
    return state("Procesando", "sky", "activity")
  if (document.processingStatus === "queued")
    return state("En cola", "warning", "clock")
  if (document.status === "failed" || document.processingStatus === "failed")
    return state("Error", "error", "x")
  if (
    document.status === "processing" &&
    document.processingStatus === "not_queued"
  )
    return state("Sin procesar", "slate", "minus")
  return unknownStatus
}
