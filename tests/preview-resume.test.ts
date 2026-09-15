import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ query: vi.fn(), identity: vi.fn() }))
vi.mock("../packages/server/src/auth", () => ({
  requireVerifiedUser: async () => ({ authId: "verified-user", email: null }),
}))
vi.mock("@agentonic/database/client", () => ({ withIdentity: mocks.identity }))
import { loadCandidatePreview } from "../packages/server/src/preview"
const ids = [1, 2, 3, 4].map(
  (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
) as [string, string, string, string]
beforeEach(() => {
  vi.resetAllMocks()
  mocks.identity.mockImplementation(async (_actor, _workspace, fn) =>
    fn({ $queryRaw: mocks.query })
  )
})
it("rejects invalid deep links before database access", async () => {
  expect(
    await loadCandidatePreview(ids[0], ids[1], "invalid", ids[3])
  ).toBeNull()
  expect(mocks.identity).not.toHaveBeenCalled()
})
it("does not load transcript state when candidate/session/actor metadata do not match", async () => {
  mocks.query.mockResolvedValueOnce([])
  expect(await loadCandidatePreview(...ids)).toBeNull()
  expect(mocks.query).toHaveBeenCalledTimes(1)
  expect(mocks.identity).toHaveBeenCalledWith(
    "verified-user",
    ids[0],
    expect.any(Function),
    null
  )
})
it("rechecks live preview authority before restoring a matching session", async () => {
  mocks.query
    .mockResolvedValueOnce([{ id: ids[3] }])
    .mockResolvedValueOnce([{ result: { ok: false, code: "unavailable" } }])
  expect(await loadCandidatePreview(...ids)).toBeNull()
})
it("restores the exact existing state without starting or renewing a preview", async () => {
  const result = {
    ok: true,
    id: ids[3],
    expiresAt: "2026-09-15T10:00:00Z",
    budgetUsd: 0.25,
    committedMicrousd: 7,
    turns: [],
  }
  mocks.query
    .mockResolvedValueOnce([{ id: ids[3] }])
    .mockResolvedValueOnce([{ result }])
  expect(await loadCandidatePreview(...ids)).toEqual(result)
  expect(mocks.query).toHaveBeenCalledTimes(2)
})
