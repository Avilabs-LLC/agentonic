import { describe, expect, it } from "vitest"
import {
  submissionForm,
  workflowRequirements,
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
      submissionForm.safeParse({ candidateId: id, note: "", consent: false })
        .success
    ).toBe(false)
    expect(
      submissionForm.safeParse({ candidateId: id, note: "", consent: true })
        .success
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
