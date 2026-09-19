import { approvalReason } from "./lifecycle"
import { z } from "zod"
import { toolGrants } from "./tools"
import { draftContent } from "./authoring"
import { reviewCriterion } from "./review-flow"
export const reviewReceipt = z.object({
  id: z.uuid(),
  agentName: z.string(),
  workspaceName: z.string(),
  timezone: z.string(),
  number: z.number(),
  versionNumber: z.number().int().positive(),
  submittedAt: z.string(),
  configurationHash: z.string(),
  contentAvailable: z.boolean(),
  reportAvailable: z.boolean(),
  content: draftContent.nullable(),
  note: z.string().nullable(),
  tools: toolGrants.optional(),
  collections: z.array(z.object({ id: z.uuid(), name: z.string() })),
  approval: z.object({
    id: z.uuid(),
    createdAt: z.string(),
    expiresAt: z.string(),
    valid: z.boolean(),
    reason: approvalReason.optional(),
    automatic: z.boolean(),
    reviewerName: z.string().nullable(),
    feedback: z.string().nullable(),
  }),
  evaluation: z.object({
    id: z.uuid(),
    status: z.string(),
    finishedAt: z.string().nullable(),
    confirmedAt: z.string().nullable(),
    budgetUsd: z.number(),
    committedMicrousd: z.number(),
    evidenceHash: z.string(),
  }),
  criteria: z.array(reviewCriterion),
  results: z.array(
    z.object({
      key: z.string(),
      kind: z.string(),
      question: z.string(),
      expectedAnswer: z.string(),
      outcome: z.string(),
      answer: z.string(),
      explanation: z.string(),
      suggestion: z.string(),
    })
  ),
})
export type ReviewReceipt = z.infer<typeof reviewReceipt>
