import { expect, it } from "vitest"
import {
  evaluationModels,
  modelConfiguration,
} from "../packages/contracts/src/models"
import {
  batchModelGroups,
  batchPassed,
  batchRunning,
  evaluationBatch,
  reviewFlowCommand,
} from "../packages/contracts/src/review-flow"
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
it("validates model-specific reasoning levels and rejects duplicate paid configurations", () => {
  expect(
    modelConfiguration.safeParse({ model: "gpt-6-astra", reasoning: "none" })
      .success
  ).toBe(false)
  expect(
    modelConfiguration.safeParse({
      model: "gpt-4.1-mini-2025-04-14",
      reasoning: "high",
    }).success
  ).toBe(false)
  const choice = { model: "gpt-5.4-mini", reasoning: "medium" }
  expect(evaluationModels.safeParse([choice, choice]).success).toBe(false)
  expect(
    evaluationModels.safeParse([choice, { ...choice, reasoning: "high" }])
      .success
  ).toBe(true)
  expect(
    reviewFlowCommand.safeParse({
      operation: "run",
      payload: {
        preparationId: id(1),
        revision: 2,
        models: [choice],
        budgetUsd: 3,
        consent: false,
        requestId: id(2),
      },
    }).success
  ).toBe(false)
})
it("counts a model as fully passing only when every selected level completed and passed every situation", () => {
  const run = {
    model: "gpt-5.4-mini",
    reasoning: "medium",
    status: "passed",
    total: 6,
    completed: 6,
    passed: 6,
    committedMicrousd: 100,
    grader: "fixture",
    errorCode: null,
    results: [],
  }
  const batch = evaluationBatch.parse({
    id: id(1),
    revision: 2,
    createdAt: "2026-09-19T00:00:00Z",
    budgetUsd: 3,
    models: [
      { ...run, id: id(2) },
      { ...run, id: id(3), reasoning: "high", passed: 4, status: "failed" },
      { ...run, id: id(4), model: "gpt-6-astra", reasoning: "low" },
    ],
  })
  expect(batchModelGroups(batch)).toHaveLength(2)
  expect(batchPassed(batch)).toBe(1)
  expect(batchRunning(batch)).toBe(false)
  batch.models[1]!.status = "running"
  expect(batchRunning(batch)).toBe(true)
  expect(batchPassed(batch)).toBe(1)
  batch.models[1]!.status = "passed"
  batch.models[1]!.passed = 6
  expect(batchPassed(batch)).toBe(2)
})
