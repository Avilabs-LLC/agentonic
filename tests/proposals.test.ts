import { describe, expect, it } from "vitest"
import { approvalReason } from "../packages/contracts/src/lifecycle"
import { proposalStatus } from "../packages/contracts/src/proposals"
import type { ReviewPreparation } from "../packages/contracts/src/review-flow"

const record = {
  status: "criteria_ready",
  criteria: [
    {
      key: "example",
      question: "Una situación de prueba",
      expectedAnswer: "Respuesta de prueba",
      basis: "",
      sourceIds: [],
      needsInput: false,
      notes: "",
      excluded: false,
      exclusionReason: "",
    },
  ],
  batches: [],
} satisfies Pick<ReviewPreparation, "status" | "criteria" | "batches">

function evaluated(
  status: string,
  preparationStatus: ReviewPreparation["status"] = "evaluating"
) {
  return {
    ...record,
    status: preparationStatus,
    batches: [
      {
        id: "batch",
        revision: 1,
        createdAt: "2026-09-20T00:00:00Z",
        budgetUsd: 0.25,
        models: [
          {
            id: "run",
            model: "gpt-5.4-mini",
            reasoning: "medium",
            status,
            total: 1,
            completed: status === "passed" ? 1 : 0,
            passed: status === "passed" ? 1 : 0,
            committedMicrousd: 0,
            grader: null,
            errorCode: null,
            results: [],
          },
        ],
      },
    ],
  }
}

describe("proposal standing", () => {
  it("keeps criteria preparation, confirmation and execution in one overall state", () => {
    expect(proposalStatus("submitted", undefined, undefined)).toBe(
      "in_progress"
    )
    for (const status of ["queued", "preparing", "criteria_ready"] as const)
      expect(
        proposalStatus("in_review", { ...record, status }, undefined)
      ).toBe("in_progress")
    for (const status of ["queued", "running", "awaiting_consent"])
      expect(proposalStatus("in_review", evaluated(status), undefined)).toBe(
        "in_progress"
      )
  })

  it("does not equate all passing models with approval", () => {
    expect(
      proposalStatus(
        "in_review",
        evaluated("passed", "criteria_ready"),
        undefined
      )
    ).toBe("in_progress")
  })

  it("requires verified current approval, including while another evaluation runs", () => {
    for (const reason of approvalReason.options)
      expect(proposalStatus("approved", evaluated("running"), { reason })).toBe(
        reason === "valid" ? "approved" : "needs_attention"
      )
    expect(
      proposalStatus("approved", { ...record, status: "approved" }, undefined)
    ).toBe("needs_attention")
  })

  it("preserves closed decisions ahead of approval and evaluation progress", () => {
    for (const status of ["rejected", "withdrawn", "revoked"])
      expect(
        proposalStatus(status, evaluated("running"), { reason: "valid" })
      ).toBe("closed")
    expect(
      proposalStatus("in_review", { ...record, status: "revoked" }, undefined)
    ).toBe("closed")
  })

  it("shows requested adjustments and keeps explicit decisions during a rerun", () => {
    expect(
      proposalStatus("changes_requested", evaluated("running"), undefined)
    ).toBe("changes_requested")
    expect(
      proposalStatus(
        "in_review",
        { ...record, status: "needs_changes" },
        undefined
      )
    ).toBe("changes_requested")
    expect(
      proposalStatus(
        "in_review",
        evaluated("running", "needs_changes"),
        undefined
      )
    ).toBe("in_progress")
  })

  it("surfaces interruptions, cancellation, expiry and unavailable criteria", () => {
    for (const status of [
      "error",
      "cancelled",
      "expired",
      "needs_attention",
    ] as const)
      expect(
        proposalStatus("in_review", { ...record, status }, undefined)
      ).toBe("needs_attention")
    expect(
      proposalStatus("in_review", { ...record, criteria: [] }, undefined)
    ).toBe("needs_attention")
    for (const status of ["error", "cancelled"])
      expect(
        proposalStatus(
          "in_review",
          evaluated(status, "criteria_ready"),
          undefined
        )
      ).toBe("needs_attention")
  })

  it("uses the latest run rather than a historical failure", () => {
    const rerun = evaluated("running", "error")
    rerun.batches.push(...evaluated("error").batches)
    expect(proposalStatus("in_review", rerun, undefined)).toBe("in_progress")
    expect(proposalStatus("unknown", record, undefined)).toBe("needs_attention")
  })
})
