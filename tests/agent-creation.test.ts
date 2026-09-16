import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  query: vi.fn(),
  latest: vi.fn(),
  auth: vi.fn(),
}))
vi.mock("../packages/server/src/auth", () => ({
  requireVerifiedUser: mocks.auth,
}))
vi.mock("../packages/server/src/catalog", () => ({
  latestCreationTemplate: mocks.latest,
}))
vi.mock("@agentonic/database/client", () => ({ withIdentity: mocks.identity }))
import { createCustomerAgent } from "../packages/server/src/access"
const workspace = "10000000-0000-4000-8000-000000000001"
const template = "10000000-0000-4000-8000-000000000002"
const agent = "10000000-0000-4000-8000-000000000003"
const input = {
  name: "Synthetic agent",
  slug: "synthetic-agent",
  description: "Synthetic fixture",
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ authId: "verified-user", email: null })
  mocks.identity.mockImplementation(async (_actor, _workspace, run) =>
    run({ $queryRaw: mocks.query })
  )
  mocks.latest.mockResolvedValue(template)
  mocks.query.mockResolvedValue([
    { result: { ok: true, id: agent, data: null } },
  ])
})
it("assigns the fresh server-selected template within the verified workspace transaction", async () => {
  expect(await createCustomerAgent(workspace, input)).toMatchObject({
    ok: true,
    id: agent,
  })
  expect(mocks.auth).toHaveBeenCalledWith("customer")
  expect(mocks.identity).toHaveBeenCalledWith(
    "verified-user",
    workspace,
    expect.any(Function),
    null
  )
  expect(JSON.parse(mocks.query.mock.calls[0]![1])).toEqual({
    ...input,
    templateVersionId: template,
  })
})
it("rejects client template, runtime and owner overrides", async () => {
  for (const extra of [
    { templateVersionId: agent },
    { codeReleaseId: agent },
    { ownerMemberId: agent },
  ]) {
    expect(
      (await createCustomerAgent(workspace, { ...input, ...extra })).ok
    ).toBe(false)
  }
  expect(mocks.identity).not.toHaveBeenCalled()
})
it("does not create an agent when no eligible release exists", async () => {
  mocks.latest.mockResolvedValue(null)
  expect((await createCustomerAgent(workspace, input)).ok).toBe(false)
  expect(mocks.query).not.toHaveBeenCalled()
})
it("uses a newly published selection instead of a previous dialog's catalog", async () => {
  mocks.latest.mockResolvedValue(agent)
  await createCustomerAgent(workspace, input)
  expect(JSON.parse(mocks.query.mock.calls[0]![1]).templateVersionId).toBe(
    agent
  )
})
it("does not claim success when the database denies creation", async () => {
  mocks.query.mockResolvedValue([{ result: { ok: false } }])
  expect((await createCustomerAgent(workspace, input)).ok).toBe(false)
})
it("aborts its transaction if the eligible default changes while creation acquires the workspace lock", async () => {
  mocks.latest.mockResolvedValueOnce(template).mockResolvedValueOnce(null)
  expect((await createCustomerAgent(workspace, input)).ok).toBe(false)
  expect(mocks.latest).toHaveBeenCalledTimes(2)
})
