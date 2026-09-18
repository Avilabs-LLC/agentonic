import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  overview: vi.fn(),
  identity: vi.fn(),
  query: vi.fn(),
}))
vi.mock("../packages/server/src/auth", () => ({
  requireVerifiedUser: mocks.auth,
  requireIdentity: mocks.overview,
}))
vi.mock("@agentonic/database/client", () => ({ withIdentity: mocks.identity }))
import { loadCustomerAgentListing } from "../packages/server/src/authoring"
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const workspaces = [1, 2, 3].map((n) => ({ id: id(n), name: `Synthetic ${n}` }))
const row = (workspace: string) => ({
  id: workspace,
  name: "Synthetic agent",
  slug: "synthetic-agent",
  description: null,
  status: "draft",
  canEdit: false,
  configuration: null,
})
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({
    authId: id(99),
    email: "test@example.invalid",
  })
  mocks.overview.mockResolvedValue({ hasAccess: true, workspaces })
  mocks.query.mockImplementation(async (workspace) => [
    { result: [row(workspace)] },
  ])
  mocks.identity.mockImplementation(async (_actor, workspace, run) =>
    run({
      $queryRaw: () => mocks.query(workspace),
    })
  )
})
it("combines active memberships with trusted per-row workspace identity and isolated reads", async () => {
  const result = await loadCustomerAgentListing()
  expect(result?.agents).toEqual(
    workspaces.map((workspace) => ({
      ...row(workspace.id),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    }))
  )
  expect(result?.selectedWorkspaceIds).toEqual([])
  expect(mocks.overview).toHaveBeenCalledWith("customer")
  expect(
    mocks.identity.mock.calls.map(([actor, workspace]) => [actor, workspace])
  ).toEqual(workspaces.map((workspace) => [id(99), workspace.id]))
})
it("supports multiple selections, deduplicates them, and preserves all filter choices", async () => {
  const result = await loadCustomerAgentListing([id(1), id(3), id(1)])
  expect(result?.workspaces).toEqual(workspaces)
  expect(result?.selectedWorkspaceIds).toEqual([id(1), id(3)])
  expect(mocks.query.mock.calls.map(([workspace]) => workspace)).toEqual([
    id(1),
    id(3),
  ])
})
it("preserves existing single-workspace URLs", async () => {
  const result = await loadCustomerAgentListing(id(2))
  expect(result?.agents).toHaveLength(1)
  expect(result?.agents[0]?.workspaceId).toBe(id(2))
})
it("rejects the entire selection before reading any unrecognized workspace", async () => {
  expect(await loadCustomerAgentListing([id(1), id(999)])).toBeNull()
  expect(await loadCustomerAgentListing("invalid")).toBeNull()
  expect(mocks.identity).not.toHaveBeenCalled()
})
it("does not return partial success after a workspace read fails", async () => {
  mocks.query.mockImplementation(async (workspace) => {
    if (workspace === id(2)) throw new Error("Access revoked")
    return [{ result: [row(workspace)] }]
  })
  await expect(loadCustomerAgentListing()).rejects.toThrow("Access revoked")
})
it("denies users without customer access", async () => {
  mocks.overview.mockResolvedValue({ hasAccess: false, workspaces: [] })
  expect(await loadCustomerAgentListing()).toBeNull()
  expect(mocks.identity).not.toHaveBeenCalled()
})
