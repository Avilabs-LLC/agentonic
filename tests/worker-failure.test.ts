import { expect, it } from "vitest"
import { workerFailure } from "../apps/worker/src/failure"
it("distinguishes validation/provider failures from real authorization loss without private logs", () => {
  expect(workerFailure(new Error("runtime_mismatch"))).toEqual({
    code: "provider_unavailable",
    diagnostic: "runtime_mismatch",
  })
  expect(
    workerFailure(
      Object.assign(new Error("private SQL arguments"), { code: "42501" })
    )
  ).toEqual({ code: "lease_lost", diagnostic: "authorization_denied" })
  expect(workerFailure(new Error("private provider payload"))).toEqual({
    code: "lease_lost",
    diagnostic: "unclassified_failure",
  })
  expect(workerFailure(new Error("budget_exhausted"))).toMatchObject({
    code: "budget_exhausted",
  })
})
it("preserves safe answer diagnostics across the worker boundary", async () => {
  const { PreviewFailure } = await import("../apps/worker/src/failure")
  expect(workerFailure(new PreviewFailure("answer_citations_invalid"))).toEqual(
    { code: "provider_unavailable", diagnostic: "answer_citations_invalid" }
  )
})
