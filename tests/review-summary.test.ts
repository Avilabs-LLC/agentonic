import { expect, it } from "vitest"
import {
  criterionWasEdited,
  type ReviewCriterion,
} from "../packages/contracts/src/review-flow"
const criterion: ReviewCriterion = {
  key: "delivery",
  question: "¿Cómo se entrega el pedido?",
  expectedAnswer: "Describe los pasos documentados.",
  basis: "Información autorizada.",
  sourceIds: [],
  needsInput: false,
  notes: "",
  excluded: false,
  exclusionReason: "",
  reviewDecision: "approved",
}
const originals = [
  {
    key: criterion.key,
    question: criterion.question,
    expectedAnswer: criterion.expectedAnswer,
  },
]
it("compares prompt and response against the original proposal, independently of notes and decisions", () => {
  expect(criterionWasEdited(criterion, originals)).toBe(false)
  expect(
    criterionWasEdited(
      {
        ...criterion,
        notes: "Una aclaración.",
        reviewDecision: "not_applicable",
        excluded: true,
        exclusionReason: "No corresponde.",
      },
      originals
    )
  ).toBe(false)
  expect(
    criterionWasEdited(
      { ...criterion, question: "¿Qué pasos requiere la entrega?" },
      originals
    )
  ).toBe(true)
  expect(
    criterionWasEdited(
      {
        ...criterion,
        expectedAnswer: "Pide la ubicación antes de explicar la entrega.",
      },
      originals
    )
  ).toBe(true)
  expect(
    criterionWasEdited(
      { ...criterion, question: ` ${criterion.question} ` },
      originals
    )
  ).toBe(false)
})
it("distinguishes customer additions from edited AI cases and unavailable comparison data", () => {
  expect(criterionWasEdited({ ...criterion, key: "added" }, originals)).toBe(
    false
  )
  expect(criterionWasEdited(criterion, undefined)).toBe(null)
})
