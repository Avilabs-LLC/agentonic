import { z } from "zod"
import { evaluationModels } from "./models"
export const reviewFlowResult = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), id: z.uuid() }),
  z.object({ ok: z.literal(false), code: z.string().optional() }),
])
const text = (max: number) =>
  z.string().trim().max(max, `Usa como máximo ${max} caracteres.`)
export const reviewCriterion = z
  .object({
    key: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    question: text(1000).min(10, "Escribe la situación que quieres comprobar."),
    expectedAnswer: text(2000),
    basis: text(1500),
    sourceIds: z.array(z.uuid()).max(8),
    needsInput: z.boolean(),
    notes: text(1500),
    excluded: z.boolean(),
    exclusionReason: text(500),
    reviewDecision: z
      .enum(["pending", "approved", "not_applicable"])
      .optional(),
  })
  .strict()
  .refine(
    (c) => !c.excluded || c.exclusionReason.length >= 5,
    "Explica por qué este caso no aplica."
  )
export const reviewCriteria = z
  .array(reviewCriterion)
  .min(1)
  .max(12)
  .refine(
    (cases) => new Set(cases.map((c) => c.key)).size === cases.length,
    "Las situaciones deben tener claves distintas."
  )
export const reviewFlowCommand = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("prepare"),
      payload: z
        .object({
          submissionId: z.uuid(),
          budgetUsd: z.number().min(0.1).max(1),
          consent: z.literal(true),
          requestId: z.uuid(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("save"),
      payload: z
        .object({
          preparationId: z.uuid(),
          revision: z.number().int().nonnegative(),
          criteria: reviewCriteria,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("confirm"),
      payload: z
        .object({
          preparationId: z.uuid(),
          revision: z.number().int().nonnegative(),
          consent: z.literal(true),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("run"),
      payload: z
        .object({
          preparationId: z.uuid(),
          revision: z.number().int().nonnegative(),
          models: evaluationModels,
          budgetUsd: z.number().min(0.05).max(50),
          consent: z.literal(true),
          requestId: z.uuid(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("cancel"),
      payload: z.object({ preparationId: z.uuid() }).strict(),
    })
    .strict(),
])
export const originalReviewCriterion = z.object({
  key: z.string(),
  question: z.string(),
  expectedAnswer: z.string(),
})
export const reviewResults = z.array(
  z.object({
    key: z.string(),
    question: z.string(),
    expectedAnswer: z.string(),
    kind: z.enum(["business", "platform"]),
    outcome: z.string(),
    answer: z.string(),
    explanation: z.string(),
    suggestion: z.string(),
    sources: z.array(z.object({ id: z.uuid(), text: z.string() })),
  })
)
export const modelEvaluation = z.object({
  id: z.uuid(),
  model: z.string(),
  reasoning: z.string().nullable(),
  status: z.string(),
  total: z.number(),
  completed: z.number(),
  passed: z.number(),
  committedMicrousd: z.number(),
  grader: z.string().nullable(),
  errorCode: z.string().nullable(),
  results: reviewResults,
})
export const evaluationBatch = z.object({
  id: z.uuid(),
  revision: z.number(),
  createdAt: z.string(),
  budgetUsd: z.number(),
  models: z.array(modelEvaluation),
})
export type EvaluationBatch = z.infer<typeof evaluationBatch>
export function batchRunning(batch: EvaluationBatch | undefined) {
  return !!batch?.models.some((m) =>
    ["queued", "running", "awaiting_consent"].includes(m.status)
  )
}
export function batchModelGroups(batch: EvaluationBatch) {
  return [...new Set(batch.models.map((m) => m.model))].map((model) => {
    const configurations = batch.models.filter((m) => m.model === model)
    const passed = configurations.every(
      (m) => m.status === "passed" && m.total > 0 && m.passed === m.total
    )
    return {
      model,
      configurations,
      passed: configurations.reduce((sum, m) => sum + m.passed, 0),
      total: configurations.reduce((sum, m) => sum + m.total, 0),
      status: configurations.some((m) => m.status === "running")
        ? "running"
        : configurations.some((m) => m.status === "queued")
          ? "queued"
          : passed
            ? "passed"
            : configurations.some((m) =>
                  ["error", "cancelled"].includes(m.status)
                )
              ? "error"
              : "failed",
    }
  })
}
export function batchPassed(batch: EvaluationBatch) {
  return batchModelGroups(batch).filter((m) => m.status === "passed").length
}
export const reviewPreparation = z.object({
  agentName: z.string().nullable().optional(),
  versionNumber: z.number().int().positive().nullable().optional(),
  originalCriteria: z.array(originalReviewCriterion).optional(),
  id: z.uuid(),
  submissionId: z.uuid(),
  status: z.enum([
    "queued",
    "preparing",
    "criteria_ready",
    "evaluating",
    "approved",
    "needs_changes",
    "needs_attention",
    "error",
    "cancelled",
    "revoked",
    "expired",
  ]),
  revision: z.number(),
  confirmedRevision: z.number().nullable().default(null),
  canRun: z.boolean().nullable().default(false).transform(Boolean),
  batches: z.array(evaluationBatch).default([]),
  criteria: z.array(reviewCriterion),
  budgetUsd: z.number(),
  committedMicrousd: z.number(),
  expiresAt: z.string(),
  canEdit: z.boolean(),
  canCancel: z.boolean(),
  evaluationId: z.uuid().nullable(),
  canApprove: z.boolean(),
  evidenceHash: z.string().nullable(),
  summary: z.string(),
  results: reviewResults,
  sources: z.array(z.object({ id: z.uuid(), text: z.string() })),
})
export type ReviewCriterion = z.infer<typeof reviewCriterion>
export type ReviewPreparation = z.infer<typeof reviewPreparation>
export const reviewFlowState = z.object({
  canPrepare: z.boolean(),
  canDecide: z.boolean().optional(),
  preparations: z.array(reviewPreparation),
})
export function criterionReviewed(criterion: ReviewCriterion) {
  return (
    criterion.reviewDecision === "approved" ||
    criterion.reviewDecision === "not_applicable"
  )
}
export function criterionDecisionLabel(
  criterion: ReviewCriterion,
  confirmed = false
) {
  if (
    criterion.reviewDecision === "not_applicable" ||
    (confirmed && criterion.excluded)
  )
    return "No aplica"
  if (criterion.reviewDecision === "approved") return "Aprobada"
  return confirmed ? "Confirmada" : "Pendiente"
}
export type ReviewFlowState = z.infer<typeof reviewFlowState>
export const reviewFlowLabels: Record<ReviewPreparation["status"], string> = {
  queued: "Preparando criterios",
  preparing: "Preparando criterios",
  criteria_ready: "Confirma qué debe hacer tu agente",
  evaluating: "Evaluando la versión",
  approved: "Versión aprobada",
  needs_changes: "Necesita ajustes",
  needs_attention: "Requiere atención",
  error: "Revisión interrumpida",
  cancelled: "Revisión cancelada",
  revoked: "Aprobación revocada",
  expired: "Aprobación sin vigencia",
}

export function criterionWasEdited(
  criterion: ReviewCriterion,
  originals: ReviewPreparation["originalCriteria"]
) {
  if (!originals) return null
  const original = originals.find((c) => c.key === criterion.key)
  if (!original) return false
  return (
    criterion.question.trim() !== original.question.trim() ||
    criterion.expectedAnswer.trim() !== original.expectedAnswer.trim()
  )
}
