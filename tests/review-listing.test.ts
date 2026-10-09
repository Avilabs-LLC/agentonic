import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  identity: vi.fn(),
  query: vi.fn(),
}))
vi.mock("../packages/server/src/auth", () => ({
  requireVerifiedUser: mocks.auth,
}))
vi.mock("@agentonic/database/client", () => ({ withIdentity: mocks.identity }))
import { loadReviewListing } from "../packages/server/src/authoring"
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const workspaces = [
  { id: id(1), name: "Synthetic A" },
  { id: id(2), name: "Synthetic B" },
]
const row = (workspace: string) => ({
  id: workspace === id(1) ? id(10) : id(20),
  agentName: "Synthetic agent",
  number: 1,
  versionNumber: 2,
  status: "submitted",
  userId: id(30),
  userName: "Synthetic submitter",
  userEmail: "submitter@example.invalid",
  canOpen: true,
  canDecide: false,
})
beforeEach(() => {
  vi.resetAllMocks()
  mocks.auth.mockResolvedValue({ authId: id(99) })
  mocks.query.mockImplementation(async (workspace) =>
    workspace === null ? workspaces : [{ result: [row(workspace)] }]
  )
  mocks.identity.mockImplementation(async (_actor, workspace, run) =>
    run({
      $queryRaw: (...query: unknown[]) => mocks.query(workspace, ...query),
    })
  )
})
it("defaults to all discovered workspaces and preserves each row's workspace for review actions", async () => {
  const result = await loadReviewListing()
  expect(result?.workspaces).toEqual(workspaces)
  expect(result?.reviews).toEqual(
    workspaces.map((workspace) => ({
      ...row(workspace.id),
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    }))
  )
  expect(
    mocks.identity.mock.calls.map(([actor, workspace]) => ({
      actor,
      workspace,
    }))
  ).toEqual([
    { actor: id(99), workspace: null },
    { actor: id(99), workspace: id(1) },
    { actor: id(99), workspace: id(2) },
  ])
  expect(mocks.auth).toHaveBeenCalledWith("admin")
})
it("filters server reads to the requested discovered workspace while preserving filter options", async () => {
  const result = await loadReviewListing(id(2))
  expect(result?.workspaces).toEqual(workspaces)
  expect(result?.reviews).toMatchObject([
    { id: id(20), workspaceId: id(2), workspaceName: "Synthetic B" },
  ])
  expect(mocks.query.mock.calls.map(([workspace]) => workspace)).toEqual([
    null,
    id(2),
  ])
})
it("does not read an undiscovered or malformed client-supplied workspace", async () => {
  expect(await loadReviewListing("invalid")).toBeNull()
  expect(mocks.identity).not.toHaveBeenCalled()
  expect(await loadReviewListing(id(999))).toBeNull()
  expect(mocks.query.mock.calls.map(([workspace]) => workspace)).toEqual([null])
})
it("fails the complete listing if a workspace becomes inaccessible or its response is invalid", async () => {
  mocks.query.mockImplementation(async (workspace) => {
    if (workspace === null) return workspaces
    if (workspace === id(2)) throw new Error("Access revoked")
    return [{ result: [row(workspace)] }]
  })
  expect(await loadReviewListing()).toBeNull()
  mocks.query.mockImplementation(async (workspace) =>
    workspace === null ? workspaces : [{ result: [{}] }]
  )
  expect(await loadReviewListing()).toBeNull()
})
it("returns an empty listing without querying a made-up default workspace", async () => {
  mocks.query.mockResolvedValue([])
  expect(await loadReviewListing()).toEqual({ workspaces: [], reviews: [] })
  expect(mocks.identity).toHaveBeenCalledTimes(1)
})
it("does not mask a failed workspace discovery as an empty queue", async () => {
  mocks.query.mockRejectedValue(new Error("Unavailable"))
  expect(await loadReviewListing()).toBeNull()
  expect(mocks.identity).toHaveBeenCalledTimes(1)
})
