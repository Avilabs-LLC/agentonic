import { expect, it } from "vitest"
import {
  evaluationModels,
  modelConfiguration,
  suggestedEvaluationBudget,
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
it("no longer offers GPT-4.1 mini for new evaluations or test chats, but still names it (§56)", async () => {
  const { selectableModels, modelConfigurationLabel } =
    await import("../packages/contracts/src/models")
  const { previewCommand } = await import("../packages/contracts/src/preview")
  const retired = { model: "gpt-4.1-mini-2025-04-14", reasoning: null }
  expect(selectableModels.map((m) => m.id)).not.toContain(retired.model)
  expect(modelConfiguration.safeParse(retired).success).toBe(true)
  expect(evaluationModels.safeParse([retired]).success).toBe(false)
  expect(modelConfigurationLabel(retired)).toBe("GPT-4.1 mini")
  const turn = (model: string) =>
    previewCommand.safeParse({
      operation: "turn",
      payload: {
        agentId: id(1),
        previewId: id(2),
        query: "Hola",
        requestKey: id(3),
        model,
      },
    }).success
  expect(turn(retired.model)).toBe(false)
  expect(turn("gpt-5.4-mini")).toBe(true)
})

it("suggests an evaluation limit that leaves room for each model's reservations (§70)", () => {
  const suggest = (models: { model: string; reasoning: string | null }[]) =>
    suggestedEvaluationBudget(models.map((m) => modelConfiguration.parse(m)))
  // Nico's evaluation on 13 October: GPT-5.4 and Astra shared US$3.00, and
  // Astra's 10-email case was refused a US$1.10 reservation at US$1.93 spent.
  expect(
    suggest([
      { model: "gpt-5.4", reasoning: "medium" },
      { model: "gpt-6-astra", reasoning: "low" },
    ])
  ).toBe(7)
  expect(suggest([{ model: "gpt-5.4-mini", reasoning: "medium" }])).toBe(1)
  // From high reasoning up a run writes more, so its allowance doubles.
  expect(suggest([{ model: "gpt-6-astra", reasoning: "high" }])).toBe(10)
  // Never below US$1 or above the US$50 maximum.
  expect(suggest([])).toBe(1)
  expect(
    suggest(
      ["low", "medium", "high", "xhigh", "max"].map((reasoning) => ({
        model: "gpt-6-astra",
        reasoning,
      }))
    )
  ).toBe(40)
  expect(
    suggest(
      ["low", "medium", "high", "xhigh", "max"].flatMap((reasoning) => [
        { model: "gpt-6-astra", reasoning },
        {
          model: "gpt-5.4",
          reasoning: reasoning === "max" ? "none" : reasoning,
        },
      ])
    )
  ).toBe(50)
})
