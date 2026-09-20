import { describe, expect, it } from "vitest"
import {
  submissionForm,
  workflowRequirements,
  defaultFreezeCode,
  reviewPreparation,
  preparedVersionLabel,
} from "../packages/contracts/src/workflow"
import type { AgentView } from "../packages/contracts/src/authoring"
const id = "10000000-0000-4000-8000-000000000001"
const code = "10000000-0000-4000-8000-000000000002"
const draft: AgentView["draft"] = {
  revision: 1,
  content: {
    version: 1,
    systemPrompt:
      "Instrucciones suficientemente completas para orientar las tareas del agente.",
    skills: [],
  },
  requestedAccess: { version: 1, collectionIds: [], tools: [] },
}
const candidate: AgentView["candidates"][number] = {
  id,
  version: "r1-base",
  revision: 1,
  hash: "hash",
  codeReleaseId: code,
  canSubmit: true,
  canPreview: false,
}
function state(
  overrides: Partial<Parameters<typeof workflowRequirements>[0]> = {}
) {
  return {
    draft,
    editor: { dirty: false, valid: true, pending: false, editingSkill: false },
    availableCollectionIds: [],
    availableCodeIds: [code],
    codeReleaseId: code,
    candidates: [],
    submittedCandidateIds: [],
    candidateId: id,
    consent: true,
    note: "",
    busy: false,
    ...overrides,
  }
}
describe("workflow button prerequisites", () => {
  it("reopens an already-frozen revision with its engine, regardless of catalog order", () => {
    const olderCode = "10000000-0000-4000-8000-000000000003"
    const availableCodeIds = [olderCode, code]
    const candidates = [candidate]
    const codeReleaseId = defaultFreezeCode(candidates, availableCodeIds)
    expect(codeReleaseId).toBe(code)
    expect(
      workflowRequirements(
        state({ candidates, availableCodeIds, codeReleaseId })
      ).canFreeze
    ).toBe(false)
    // Deliberately choosing another engine creates a different combination.
    expect(
      workflowRequirements(
        state({ candidates, availableCodeIds, codeReleaseId: olderCode })
      ).canFreeze
    ).toBe(true)
  })
  it("keeps the last engine after a new draft revision is saved", () => {
    const candidates = [candidate]
    const codeReleaseId = defaultFreezeCode(candidates, [id, code])
    expect(codeReleaseId).toBe(code)
    expect(
      workflowRequirements(
        state({ candidates, codeReleaseId, draft: { ...draft, revision: 2 } })
      ).canFreeze
    ).toBe(true)
  })
  it("prefers the newest available frozen engine even after submission", () => {
    expect(
      defaultFreezeCode(
        [{ ...candidate, codeReleaseId: id, canSubmit: false }, candidate],
        [code, id]
      )
    ).toBe(id)
  })
  it("skips unavailable engines and handles agents without frozen versions", () => {
    expect(
      defaultFreezeCode(
        [{ ...candidate, codeReleaseId: id }, candidate],
        [code]
      )
    ).toBe(code)
    expect(defaultFreezeCode([candidate], [id])).toBe(id)
    expect(defaultFreezeCode([], [code])).toBe(code)
    expect(defaultFreezeCode([candidate], [])).toBe("")
  })
  it("permits a valid saved prompt without optional skills or knowledge", () =>
    expect(workflowRequirements(state()).canFreeze).toBe(true))
  it.each(["dirty", "pending", "editingSkill"] as const)(
    "blocks both steps while editor state is %s",
    (key) => {
      const result = workflowRequirements(
        state({
          candidates: [candidate],
          editor: {
            dirty: false,
            valid: true,
            pending: false,
            editingSkill: false,
            [key]: true,
          },
        })
      )
      expect(result.canFreeze).toBe(false)
      expect(result.canSubmit).toBe(false)
    }
  )
  it("blocks invalid and never-saved drafts", () => {
    expect(
      workflowRequirements(state({ draft: { ...draft, revision: 0 } }))
        .canFreeze
    ).toBe(false)
    const invalid = {
      ...draft,
      content: { ...draft.content, systemPrompt: "too short" },
    }
    expect(
      workflowRequirements(state({ draft: invalid, candidates: [candidate] }))
        .canSubmit
    ).toBe(false)
    expect(
      workflowRequirements(
        state({
          editor: {
            dirty: false,
            valid: false,
            pending: false,
            editingSkill: false,
          },
        })
      ).canFreeze
    ).toBe(false)
  })
  it("requires a usable code and current collection access", () => {
    expect(
      workflowRequirements(state({ availableCodeIds: [] })).canFreeze
    ).toBe(false)
    const scoped = {
      ...draft,
      requestedAccess: { ...draft.requestedAccess, collectionIds: [id] },
    }
    const result = workflowRequirements(
      state({ draft: scoped, candidates: [candidate] })
    )
    expect(result.canFreeze).toBe(false)
    expect(result.canSubmit).toBe(false)
  })
  it("disables repeat freeze but permits submitting that exact frozen version", () => {
    const result = workflowRequirements(state({ candidates: [candidate] }))
    expect(result.canFreeze).toBe(false)
    expect(result.canSubmit).toBe(true)
  })
  it("requires consent and a valid note", () => {
    expect(
      workflowRequirements(state({ candidates: [candidate], consent: false }))
        .canSubmit
    ).toBe(false)
    expect(
      workflowRequirements(
        state({ candidates: [candidate], note: "a".repeat(2001) })
      ).canSubmit
    ).toBe(false)
    expect(
      submissionForm.safeParse({
        candidateId: id,
        note: "",
        budgetUsd: 0.25,
        consent: false,
      }).success
    ).toBe(false)
    expect(
      submissionForm.safeParse({
        candidateId: id,
        note: "",
        budgetUsd: 0.25,
        consent: true,
      }).success
    ).toBe(true)
  })
  it("blocks stale, unavailable, already-sent and missing candidates", () => {
    expect(workflowRequirements(state()).canSubmit).toBe(false)
    for (const c of [
      { ...candidate, revision: 0 },
      { ...candidate, canSubmit: false },
    ])
      expect(workflowRequirements(state({ candidates: [c] })).canSubmit).toBe(
        false
      )
    expect(
      workflowRequirements(
        state({ candidates: [candidate], submittedCandidateIds: [id] })
      ).canSubmit
    ).toBe(false)
  })
  it("blocks both steps during a request or refresh", () => {
    const result = workflowRequirements(
      state({ busy: true, candidates: [candidate] })
    )
    expect(result.canFreeze).toBe(false)
    expect(result.canSubmit).toBe(false)
  })
})

describe("single review card states", () => {
  const ready = { ...candidate, canPreview: true, number: 3 }
  it("starts without a prepared version", () => {
    expect(reviewPreparation(draft, [], code)).toEqual({
      current: undefined,
      previous: undefined,
    })
  })
  it("offers the exact current prepared version", () => {
    expect(reviewPreparation(draft, [ready], code).current?.id).toBe(id)
    expect(preparedVersionLabel(ready)).toBe("Versión 3")
  })
  it("keeps the prior test separate after saving changes", () => {
    const result = reviewPreparation({ ...draft, revision: 2 }, [ready], code)
    expect(result.current).toBeUndefined()
    expect(result.previous?.id).toBe(id)
  })
  it("does not offer an authoring-only or unavailable candidate for chat", () => {
    expect(reviewPreparation(draft, [candidate], code)).toEqual({
      current: undefined,
      previous: undefined,
    })
  })
  it("does not substitute a candidate on another engine for the assigned combination", () => {
    expect(reviewPreparation(draft, [ready], id).current).toBeUndefined()
  })
})

it("prepares a new reviewed capability family without substituting an old frozen candidate", () => {
  const research = "10000000-0000-4000-8000-000000000099"
  expect(defaultFreezeCode([candidate], [research, code], [research])).toBe(
    research
  )
  expect(candidate.codeReleaseId).toBe(code)
  expect(defaultFreezeCode([candidate], [code], [research])).toBe(code)
  expect(
    defaultFreezeCode(
      [{ ...candidate, codeReleaseId: research }, candidate],
      [code, research],
      [research]
    )
  ).toBe(research)
})
