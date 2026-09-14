import { expect, it } from "vitest"
import {
  authoringCommand,
  draftContent,
  editableDraftContent,
  systemPromptInput,
  systemPromptCharacterCount,
} from "../packages/contracts/src/authoring"

it("requires 50 non-whitespace characters without counting whitespace padding", () => {
  expect(systemPromptInput.safeParse("a".repeat(49)).success).toBe(false)
  expect(
    systemPromptInput.safeParse("a".repeat(49) + " \n\t\u00a0").success
  ).toBe(false)
  expect(systemPromptInput.safeParse("a".repeat(50)).success).toBe(true)
  expect(systemPromptCharacterCount("ab cd\nef\tgh")).toBe(8)
})
it("keeps empty and legacy drafts readable while rejecting invalid edits", () => {
  for (const systemPrompt of ["", "Short legacy prompt."]) {
    const value = { version: 1, systemPrompt, skills: [] }
    expect(draftContent.safeParse(value).success).toBe(true)
    const result = editableDraftContent.safeParse(value)
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues[0]?.path).toEqual(["systemPrompt"])
  }
})
it("rejects a short prompt at the authoring command boundary and preserves valid input", () => {
  const input = {
    workspaceId: "10000000-0000-4000-8000-000000000001",
    operation: "draft.save",
    payload: {
      agentId: "10000000-0000-4000-8000-000000000002",
      revision: 1,
      content: { version: 1, systemPrompt: "Short", skills: [] },
      requestedAccess: { version: 1, collectionIds: [], tools: [] },
    },
  }
  expect(authoringCommand.safeParse(input).success).toBe(false)
  input.payload.content.systemPrompt = "  " + "a".repeat(50) + "\n"
  expect(authoringCommand.parse(input)).toEqual(input)
  expect(systemPromptInput.safeParse("a".repeat(32001)).success).toBe(false)
})
