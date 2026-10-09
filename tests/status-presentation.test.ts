import { describe, expect, it } from "vitest"
import {
  approvalBadgeVariants,
  deploymentBadgeVariants,
  submissionBadgeVariants,
} from "../packages/ui/src/lib/badge-status"
import {
  approvalReason,
  deploymentLabels,
} from "../packages/contracts/src/lifecycle"
import { submissionLabels } from "../packages/contracts/src/authoring"

describe("shared state colors", () => {
  it("distinguishes every state within each workflow family", () => {
    for (const mapping of [
      approvalBadgeVariants,
      deploymentBadgeVariants,
      submissionBadgeVariants,
    ]) {
      const colors = Object.values(mapping)
      expect(new Set(colors).size).toBe(colors.length)
      expect(colors).not.toContain("default")
    }
  })
  it("covers every named approval, submission and deployment state", () => {
    for (const reason of approvalReason.options)
      expect(approvalBadgeVariants[reason]).toBeTruthy()
    for (const status of Object.keys(deploymentLabels))
      expect(deploymentBadgeVariants[status]).toBeTruthy()
    for (const status of Object.keys(submissionLabels))
      expect(submissionBadgeVariants[status]).toBeTruthy()
    expect(approvalBadgeVariants.unapproved).toBe("slate")
    expect(approvalBadgeVariants.expired).toBe("warning")
    // Inline approval indicators use the same tones as the badges.
    for (const reason of approvalReason.options)
      expect(statusDescriptor("approval", reason).variant).toBe(
        approvalBadgeVariants[reason]
      )
  })
})

import {
  criterionStatus,
  documentBadge,
  proposalStatus,
  statusDescriptor,
} from "../packages/ui/src/lib/badge-status"
import type { ReviewCriterion } from "../packages/contracts/src/review-flow"

const criterion: ReviewCriterion = {
  key: "example",
  question: "¿Qué información hace falta?",
  expectedAnswer: "Solicita aclaraciones.",
  basis: "",
  sourceIds: [],
  needsInput: false,
  notes: "",
  excluded: false,
  exclusionReason: "",
}

describe("status meaning and precedence", () => {
  it("keeps accepted criteria distinct from passing agent results and exclusions", () => {
    const accepted = criterionStatus({
      ...criterion,
      reviewDecision: "approved",
    })
    expect(accepted).toMatchObject({
      label: "Aprobada por el cliente",
      variant: "slate",
    })
    expect(statusDescriptor("result", "passed")).toMatchObject({
      label: "Superada",
      variant: "success",
    })
    expect(
      criterionStatus({
        ...criterion,
        excluded: true,
        reviewDecision: "not_applicable",
      })
    ).toMatchObject({ label: "No aplica", variant: "slate" })
    expect(criterionStatus(criterion)).toMatchObject({
      label: "Pendiente",
      variant: "warning",
    })
  })
  it("preserves legacy confirmation without inventing an individual approval", () => {
    expect(criterionStatus(criterion, true).label).toBe("Confirmada")
    expect(criterionStatus({ ...criterion, excluded: true }, true).label).toBe(
      "No aplica"
    )
  })
  it("prioritizes current validity over historical submission approval", () => {
    expect(proposalStatus("approved", "expired")).toMatchObject({
      variant: "warning",
      label: "Aprobación sin vigencia",
    })
    expect(proposalStatus("approved", "revoked")).toMatchObject({
      variant: "error",
      label: "Aprobación revocada",
    })
    expect(proposalStatus("approved")).toMatchObject({
      variant: "slate",
      label: "Aprobación registrada",
    })
    expect(statusDescriptor("approval", "expired")).toMatchObject({
      variant: "warning",
      label: "Vencida",
    })
  })
  it("keeps a later terminal submission decision above earlier successful review evidence", () => {
    for (const status of [
      "revoked",
      "rejected",
      "withdrawn",
      "superseded",
      "changes_requested",
    ])
      expect(proposalStatus(status, "approved")).toEqual(
        statusDescriptor("submission", status)
      )
  })
  it("does not confuse waiting, cancellation, attention or interruption with active processing", () => {
    expect(statusDescriptor("review", "needs_attention")).toMatchObject({
      variant: "warning",
      icon: "alert",
    })
    expect(statusDescriptor("evaluation", "awaiting_consent").variant).toBe(
      "warning"
    )
    expect(statusDescriptor("evaluation", "queued").variant).toBe("warning")
    expect(statusDescriptor("evaluation", "running").variant).toBe("sky")
    expect(statusDescriptor("evaluation", "cancelled").variant).toBe("slate")
    expect(statusDescriptor("review", "error").variant).toBe("error")
  })
  it("retains a usable document during reprocessing and active work after an earlier failure", () => {
    expect(
      documentBadge({ status: "ready", processingStatus: "running" }).label
    ).toBe("Listo")
    expect(
      documentBadge({ status: "ready", processingStatus: "failed" }).label
    ).toBe("Listo")
    expect(
      documentBadge({ status: "failed", processingStatus: "queued" }).label
    ).toBe("En cola")
    expect(
      documentBadge({ status: "failed", processingStatus: "running" }).label
    ).toBe("Procesando")
    expect(
      documentBadge({ status: "processing", processingStatus: "not_queued" })
        .label
    ).toBe("Sin procesar")
    expect(
      documentBadge({ status: "new_status", processingStatus: "not_queued" })
        .label
    ).toBe("Estado desconocido")
  })
  it("does not turn unknown outcomes into failure, success or a known lifecycle state", () => {
    for (const domain of [
      "agent",
      "submission",
      "review",
      "evaluation",
      "result",
      "approval",
    ] as const)
      for (const status of ["future_state", "toString", "constructor", ""])
        expect(statusDescriptor(domain, status)).toMatchObject({
          label: "Estado desconocido",
          variant: "slate",
          icon: "help",
        })
  })
})

describe("one look per state", () => {
  it("gives a deployment badge and its inline indicator the same tone", () => {
    for (const status of Object.keys(deploymentLabels))
      expect(statusDescriptor("deployment", status).variant).toBe(
        deploymentBadgeVariants[status]
      )
  })
  it("shows a superseded review like a superseded deployment", () => {
    expect(statusDescriptor("submission", "superseded")).toEqual({
      label: "Reemplazada",
      variant: "teal",
      icon: "archive",
    })
    expect(statusDescriptor("submission", "superseded").icon).toBe(
      statusDescriptor("deployment", "superseded").icon
    )
  })
  it("gives a submission badge and its inline indicator the same tone", () => {
    for (const status of Object.keys(submissionLabels))
      expect(statusDescriptor("submission", status).variant).toBe(
        submissionBadgeVariants[status]
      )
  })
})
