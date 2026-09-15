import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AgentView } from "../packages/contracts/src/authoring"
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  freeze: vi.fn(),
  preview: vi.fn(),
}))
vi.mock("../packages/server/src/authoring", () => ({
  loadAgent: mocks.load,
  runAuthoringCommand: mocks.freeze,
}))
vi.mock("../packages/server/src/preview", () => ({
  runPreviewCommand: mocks.preview,
}))
import { prepareAgentPreview } from "../packages/server/src/preparation"
const workspace = "10000000-0000-4000-8000-000000000001"
const agentId = "10000000-0000-4000-8000-000000000002"
const code = "10000000-0000-4000-8000-000000000003"
const candidateId = "10000000-0000-4000-8000-000000000004"
const previewId = "10000000-0000-4000-8000-000000000005"
let agent: AgentView
beforeEach(() => {
  vi.resetAllMocks()
  agent = {
    preparationCodeReleaseId: code,
    agent: {
      id: agentId,
      name: "Agente sintético",
      description: null,
      templateVersionId: code,
    },
    draft: {
      revision: 2,
      content: {
        version: 1,
        systemPrompt:
          "Instrucciones sintéticas suficientemente completas para orientar al agente.",
        skills: [],
      },
      requestedAccess: { version: 1, collectionIds: [], tools: [] },
    },
    candidates: [],
    submissions: [],
  }
  mocks.load.mockImplementation(async () => agent)
  mocks.freeze.mockResolvedValue({ ok: true, id: candidateId, data: null })
  mocks.preview.mockResolvedValue({ ok: true, id: previewId })
})
function existing(revision = 2) {
  agent.candidates.push({
    id: candidateId,
    version: "r2-code",
    number: 1,
    revision,
    hash: "hash",
    codeReleaseId: code,
    canPreview: true,
    canSubmit: true,
  })
}
describe("prepare and open an exact private version", () => {
  it("freezes using the server assignment and opens precisely the returned candidate", async () => {
    const result = await prepareAgentPreview(workspace, agentId, {
      revision: 2,
    })
    expect(mocks.freeze).toHaveBeenCalledWith("customer", {
      workspaceId: workspace,
      operation: "candidate.freeze",
      payload: { agentId, revision: 2, codeReleaseId: code },
    })
    expect(mocks.preview).toHaveBeenCalledWith(workspace, {
      operation: "start",
      payload: { agentId, candidateId },
    })
    expect(result).toMatchObject({
      ok: true,
      href: `/agents/${agentId}/preview?workspace=${workspace}&candidate=${candidateId}&preview=${previewId}`,
    })
  })
  it("rejects a supplied engine instead of allowing customer assignment", async () => {
    expect(
      (
        await prepareAgentPreview(workspace, agentId, {
          revision: 2,
          codeReleaseId: workspace,
        })
      ).ok
    ).toBe(false)
    expect(mocks.load).not.toHaveBeenCalled()
  })
  it("does not prepare against a stale draft revision", async () => {
    expect(
      (await prepareAgentPreview(workspace, agentId, { revision: 1 })).ok
    ).toBe(false)
    expect(mocks.freeze).not.toHaveBeenCalled()
    expect(mocks.preview).not.toHaveBeenCalled()
  })
  it("reuses a frozen version on retries instead of creating duplicates", async () => {
    existing()
    await prepareAgentPreview(workspace, agentId, { revision: 2 })
    expect(mocks.freeze).not.toHaveBeenCalled()
    expect(mocks.preview).toHaveBeenCalledWith(workspace, {
      operation: "start",
      payload: { agentId, candidateId },
    })
  })
  it("opens a requested earlier version without preparing the newer draft", async () => {
    existing(1)
    await prepareAgentPreview(workspace, agentId, { revision: 2, candidateId })
    expect(mocks.freeze).not.toHaveBeenCalled()
    expect(mocks.preview).toHaveBeenCalledWith(workspace, {
      operation: "start",
      payload: { agentId, candidateId },
    })
  })
  it("rejects unavailable or foreign candidates without substituting another", async () => {
    expect(
      (
        await prepareAgentPreview(workspace, agentId, {
          revision: 2,
          candidateId,
        })
      ).ok
    ).toBe(false)
    existing()
    agent.candidates[0]!.canPreview = false
    expect(
      (
        await prepareAgentPreview(workspace, agentId, {
          revision: 2,
          candidateId,
        })
      ).ok
    ).toBe(false)
    expect(mocks.freeze).not.toHaveBeenCalled()
    expect(mocks.preview).not.toHaveBeenCalled()
  })
  it("requires a configured engine and valid saved draft for preparation", async () => {
    agent.preparationCodeReleaseId = null
    expect(
      (await prepareAgentPreview(workspace, agentId, { revision: 2 })).ok
    ).toBe(false)
    agent.preparationCodeReleaseId = code
    agent.draft.content.systemPrompt = "short"
    expect(
      (await prepareAgentPreview(workspace, agentId, { revision: 2 })).ok
    ).toBe(false)
    expect(mocks.freeze).not.toHaveBeenCalled()
  })
  it("does not start a preview if freezing fails", async () => {
    mocks.freeze.mockResolvedValue({ ok: false })
    expect(
      (await prepareAgentPreview(workspace, agentId, { revision: 2 })).ok
    ).toBe(false)
    expect(mocks.preview).not.toHaveBeenCalled()
  })
  it("preserves a prepared candidate if starting is denied and retries that candidate", async () => {
    mocks.preview.mockResolvedValueOnce({ ok: false, code: "rate_limit" })
    const result = await prepareAgentPreview(workspace, agentId, {
      revision: 2,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("La versión se conserva.")
    existing()
    expect(
      (await prepareAgentPreview(workspace, agentId, { revision: 2 })).ok
    ).toBe(true)
    expect(mocks.freeze).toHaveBeenCalledTimes(1)
  })
})
