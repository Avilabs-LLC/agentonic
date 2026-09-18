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
  })
})
