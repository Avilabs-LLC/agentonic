import { beforeEach, expect, it, vi } from "vitest"
import { WEB_GRANT } from "../packages/contracts/src/web"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  identity: vi.fn(),
  query: vi.fn(),
}))
vi.mock("../packages/server/src/auth", () => ({
  requireVerifiedUser: mocks.auth,
}))
vi.mock("@agentonic/database/client", () => ({ withIdentity: mocks.identity }))
import { loadAgent } from "../packages/server/src/authoring"

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const frozenContent = {
  version: 1,
  systemPrompt: "Instrucciones originales de la versión sintética.",
  skills: [],
}
const frozenAccess = { version: 1, collectionIds: [id(6)], tools: [WEB_GRANT] }
const detail = {
  agent: {
    id: id(2),
    name: "Agente sintético",
    description: null,
    templateVersionId: id(3),
  },
  draft: {
    revision: 9,
    content: {
      ...frozenContent,
      systemPrompt: "Instrucciones nuevas del borrador, ajenas a la propuesta.",
    },
    requestedAccess: { version: 1, collectionIds: [], tools: [] },
  },
  candidates: [{ id: id(4), version: "r1", revision: 1, hash: "synthetic" }],
  submissions: [],
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ authId: id(99) })
  mocks.identity.mockImplementation(async (_actor, _workspace, run) =>
    run({ $queryRaw: mocks.query })
  )
  mocks.query.mockImplementation(async (sql: TemplateStringsArray) => {
    const query = sql.join("")
    if (query.includes("authoring_command"))
      return [{ result: { ok: true, id: null, data: detail } }]
    if (query.includes("FROM agentonic.configuration_releases r"))
      return [
        {
          id: id(4),
          codeReleaseId: id(3),
          eligible: false,
          previewAvailable: false,
          content: frozenContent,
          requestedAccess: {
            ...frozenAccess,
            collections: [
              { id: id(6), sources: [{ id: id(7), hash: "synthetic" }] },
            ],
          },
          number: 1,
          createdAt: "2026-09-20T00:00:00Z",
        },
      ]
    return []
  })
})

it("keeps the proposal's original prompt and access scope after the draft changes", async () => {
  const result = await loadAgent(id(1), id(2))
  expect(result?.candidates[0]?.snapshot).toEqual({
    content: frozenContent,
    requestedAccess: frozenAccess,
  })
  expect(result?.draft.content.systemPrompt).toBe(
    detail.draft.content.systemPrompt
  )
  expect(mocks.auth).toHaveBeenCalledWith("customer")
  expect(mocks.identity.mock.calls[0]?.slice(0, 2)).toEqual([id(99), id(1)])
  const snapshotQuery = mocks.query.mock.calls.find(([sql]) =>
    sql.join("").includes("FROM agentonic.configuration_releases r")
  )!
  expect(snapshotQuery.slice(1)).toEqual([id(1), id(2)])
})

it("does not replace an unavailable frozen configuration with the editable draft", async () => {
  mocks.query.mockImplementation(async (sql: TemplateStringsArray) =>
    sql.join("").includes("authoring_command")
      ? [{ result: { ok: true, id: null, data: detail } }]
      : []
  )
  const result = await loadAgent(id(1), id(2))
  expect(result).not.toBeNull()
  expect(result?.candidates[0]?.snapshot).toBeUndefined()
})

it("does not read snapshots after the authorized detail request is denied", async () => {
  mocks.query.mockResolvedValue([{ result: { ok: false } }])
  expect(await loadAgent(id(1), id(2))).toBeNull()
  expect(mocks.query).toHaveBeenCalledTimes(1)
})
