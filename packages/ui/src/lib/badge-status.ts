import { proposalLabels } from "@agentonic/contracts/proposals"
import {
  submissionLabels,
  type WorkspaceView,
} from "@agentonic/contracts/authoring"
import { evaluationStatus } from "@agentonic/contracts/evaluation"
import type { RegistrationState } from "@agentonic/contracts/expiry"
import { approvalLabels } from "@agentonic/contracts/lifecycle"
import {
  reviewFlowLabels,
  type ReviewCriterion,
} from "@agentonic/contracts/review-flow"

export type StatusTone =
  | "success"
  | "warning"
  | "error"
  | "orange"
  | "sky"
  | "violet"
  | "pink"
  | "indigo"
  | "teal"
  | "slate"
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
    revoked: state(submissionLabels.revoked!, "violet", "ban"),
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
  // Approval validity by reason; the tones match approvalBadgeVariants.
  approval: {
    unapproved: state(approvalLabels.unapproved, "slate", "minus"),
    valid: state(approvalLabels.valid, "success", "check"),
    expired: state(approvalLabels.expired, "warning", "clock"),
    superseded: state(approvalLabels.superseded, "violet", "ban"),
    consent: state(approvalLabels.consent, "pink", "alert"),
    sources_changed: state(approvalLabels.sources_changed, "orange", "pencil"),
    evidence_expired: state(approvalLabels.evidence_expired, "sky", "clock"),
    authorization_changed: state(
      approvalLabels.authorization_changed,
      "error",
      "alert"
    ),
  },
  // Customer proposal states (architecture §39.6).
  proposal: {
    in_progress: state(proposalLabels.in_progress, "sky", "activity"),
    approved: state(proposalLabels.approved, "success", "check"),
    changes_requested: state(
      proposalLabels.changes_requested,
      "orange",
      "pencil"
    ),
    needs_attention: state(proposalLabels.needs_attention, "warning", "alert"),
    closed: state(proposalLabels.closed, "slate", "minus"),
  },
  // Admin operations (architecture §52).
  workspace: {
    active: state("Activo", "success", "check"),
    suspended: state("Suspendido", "warning", "pause"),
    closing: state("En cierre", "orange", "clock"),
    closed: state("Cerrado", "slate", "archive"),
  },
  staff: {
    active: state("Activo", "success", "check"),
    disabled: state("Desactivado", "slate", "minus"),
  },
  // Workspace members and invitations (architecture §54).
  member: {
    active: state("Activo", "success", "check"),
    suspended: state("Suspendido", "warning", "pause"),
    removed: state("Retirado", "slate", "archive"),
  },
  invitation: {
    pending: state("Pendiente", "warning", "clock"),
    accepted: state("Aceptada", "success", "check"),
    // Withdrawn by the workspace: a cancellation, not a failure.
    revoked: state("Retirada", "slate", "archive"),
    expired: state("Vencida", "warning", "alert"),
  },
  release: {
    available: state("Disponible", "success", "check"),
    retired: state("Retirada", "slate", "archive"),
    revoked: state("Revocada", "error", "ban"),
  },
  // An audit event's outcome is a nested outcome, shown inline.
  outcome: {
    succeeded: state("Completada", "success", "check"),
    allowed: state("Permitida", "success", "check"),
    denied: state("Denegada", "error", "ban"),
    failed: state("Fallida", "error", "x"),
  },
  // A deployment shown inline beneath its agent; its own badge uses deploymentBadgeVariants.
  deployment: {
    none: state("Sin despliegue", "slate", "minus"),
    awaiting_activation: state("Pendiente de activación", "warning", "clock"),
    queued: state("Activación en cola", "violet", "clock"),
    preparing: state("Preparando despliegue", "sky", "activity"),
    running: state("En funcionamiento", "success", "check"),
    offline: state("Sin conexión", "orange", "alert"),
    // Tones match deploymentBadgeVariants, so a badge and an inline
    // indicator of the same state look alike.
    stopped: state("Detenido", "indigo", "pause"),
    failed: state("No se pudo activar", "error", "x"),
    superseded: state("Reemplazado", "teal", "archive"),
    unauthorized: state("Autorización no vigente", "pink", "alert"),
  },
  // Host and evaluator verification. "Vence pronto" means within a day, when
  // the twice-daily renewal should already have run.
  registration: {
    valid: state("Vigente", "success", "check"),
    expiring: state("Vence pronto", "orange", "clock"),
    expired: state("Vencida", "warning", "alert"),
    revoked: state("Revocada", "error", "ban"),
    retired: state("Retirada", "slate", "archive"),
  } satisfies Record<RegistrationState, StatusDescriptor>,
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

export const submissionBadgeVariants: Record<string, BadgeVariant> = {
  submitted: "warning",
  in_review: "sky",
  changes_requested: "orange",
  rejected: "error",
  withdrawn: "slate",
  approved: "success",
  revoked: "violet",
}

export type BadgeVariant =
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
