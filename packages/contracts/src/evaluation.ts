import { z } from "zod"
export const evaluationCase = z
  .object({
    key: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    question: z
      .string()
      .trim()
      .min(10, "Escribe al menos 10 caracteres.")
      .max(1000, "Usa como máximo 1000 caracteres."),
    expectedAnswer: z
      .string()
      .trim()
      .min(10, "Escribe al menos 10 caracteres.")
      .max(2000, "Usa como máximo 2000 caracteres."),
    requiredPhrases: z
      .array(
        z
          .string()
          .trim()
          .min(2, "Cada frase debe tener al menos 2 caracteres.")
          .max(200, "Cada frase admite hasta 200 caracteres.")
      )
      .max(12, "Incluye como máximo 12 frases."),
    forbiddenPhrases: z
      .array(
        z
          .string()
          .trim()
          .min(2, "Cada frase debe tener al menos 2 caracteres.")
          .max(200, "Cada frase admite hasta 200 caracteres.")
      )
      .max(12, "Incluye como máximo 12 frases."),
    insufficientEvidence: z.boolean(),
  })
  .strict()
  .refine(
    (c) => c.insufficientEvidence || c.requiredPhrases.length > 0,
    "Incluye al menos una frase necesaria para las respuestas con evidencia."
  )
export const evaluationCases = z
  .array(evaluationCase)
  .min(3, "Incluye al menos 3 casos.")
  .max(20, "Incluye como máximo 20 casos.")
  .refine(
    (cases) => new Set(cases.map((c) => c.key)).size === cases.length,
    "Las claves deben ser únicas."
  )
  .refine(
    (cases) =>
      cases.some((c) => c.insufficientEvidence) &&
      cases.some((c) => !c.insufficientEvidence),
    "Incluye casos con evidencia y un caso que deba abstenerse."
  )
export const evaluationCommand = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("plan"),
      payload: z
        .object({
          submissionId: z.uuid(),
          grantId: z.uuid(),
          cases: evaluationCases,
          environment: z.enum(["local", "azure_staging"]),
          budgetUsd: z.number().min(0.01).max(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("authorize"),
      payload: z
        .object({
          evaluationId: z.uuid(),
          datasetHash: z.string().regex(/^[a-f0-9]{64}$/),
          consent: z.literal(true),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("cancel"),
      payload: z.object({ evaluationId: z.uuid() }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("approve"),
      payload: z
        .object({
          evaluationId: z.uuid(),
          grantId: z.uuid(),
          evidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
          reviewed: z.literal(true),
          feedback: z
            .string()
            .trim()
            .min(10, "Escribe al menos 10 caracteres.")
            .max(2000, "Usa como máximo 2000 caracteres."),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("revoke"),
      payload: z
        .object({
          submissionId: z.uuid(),
          feedback: z
            .string()
            .trim()
            .min(10, "Escribe al menos 10 caracteres.")
            .max(2000, "Usa como máximo 2000 caracteres."),
        })
        .strict(),
    })
    .strict(),
])
export const evaluationRecord = z.object({
  id: z.uuid(),
  submissionId: z.uuid(),
  agentId: z.uuid(),
  status: z.enum([
    "awaiting_consent",
    "queued",
    "running",
    "passed",
    "failed",
    "error",
    "cancelled",
  ]),
  environment: z.enum(["local", "azure_staging"]),
  cases: z.array(evaluationCase),
  datasetHash: z.string(),
  configurationHash: z.string(),
  codeReleaseId: z.uuid(),
  accessHash: z.string(),
  evidenceHash: z.string().nullable(),
  budgetUsd: z.number(),
  committedMicrousd: z.number(),
  expiresAt: z.string(),
  authorized: z.boolean(),
  canAuthorize: z.boolean(),
  canApprove: z.boolean(),
  canCancel: z.boolean(),
  results: z.array(
    z.object({
      key: z.string(),
      outcome: z.string(),
      answer: z.string(),
      citations: z.array(z.string()),
      checks: z.record(z.string(), z.boolean()),
      sources: z.array(z.object({ id: z.uuid(), text: z.string() })),
    })
  ),
})
export type EvaluationRecord = z.infer<typeof evaluationRecord>
export const evaluationStatus: Record<EvaluationRecord["status"], string> = {
  awaiting_consent: "Pendiente de autorización",
  queued: "En cola",
  running: "Evaluando",
  passed: "Pruebas superadas",
  failed: "Pruebas no superadas",
  error: "Evaluación interrumpida",
  cancelled: "Cancelada",
}
