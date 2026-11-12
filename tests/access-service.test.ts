import { beforeEach, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
const mocks = vi.hoisted(() => ({
  verified: vi.fn(),
  transaction: vi.fn(),
  query: vi.fn(),
}))
vi.mock("../packages/server/src/auth", () => ({
  requireVerifiedUser: mocks.verified,
}))
vi.mock("@agentonic/database/client", () => ({
  withIdentity: mocks.transaction,
}))
import {
  acceptWorkspaceInvitation,
  issueWorkspaceInvitation,
  runAccessCommand,
} from "../packages/server/src/access"
const workspaceId = "00000000-0000-4000-8000-000000000101"
const authId = "00000000-0000-4000-8000-000000000001"
beforeEach(() => {
  vi.resetAllMocks()
  mocks.verified.mockResolvedValue({
    authId,
    email: "verified@example.invalid",
  })
  mocks.transaction.mockImplementation(async (_id, _workspace, operation) =>
    operation({ $queryRaw: mocks.query })
  )
  mocks.query.mockResolvedValue([
    { result: { ok: true, id: workspaceId, data: null } },
  ])
})
it("derives identity/email from server-verified Auth and passes requested workspace through the DB boundary", async () => {
  expect(
    (
      await runAccessCommand("customer", {
        workspaceId,
        operation: "member.list",
        payload: {},
      })
    ).ok
  ).toBe(true)
  expect(mocks.verified).toHaveBeenCalledWith("customer")
  expect(mocks.transaction).toHaveBeenCalledWith(
    authId,
    workspaceId,
    expect.any(Function),
    "verified@example.invalid"
  )
})
it("rejects client-supplied identity, email, role and unknown payload fields before DB access", async () => {
  expect(
    (
      await runAccessCommand("customer", {
        workspaceId,
        operation: "contact.ensure",
        payload: {},
        authId,
      })
    ).ok
  ).toBe(false)
  expect(
    (
      await runAccessCommand("customer", {
        workspaceId,
        operation: "contact.ensure",
        payload: { email: "forged@example.invalid" },
      })
    ).ok
  ).toBe(false)
  expect(mocks.transaction).not.toHaveBeenCalled()
})
it("invalid sessions do not reach the database", async () => {
  mocks.verified.mockRejectedValue(new Error("REDIRECT /login"))
  await expect(
    runAccessCommand("customer", {
      workspaceId,
      operation: "member.list",
      payload: {},
    })
  ).rejects.toThrow("REDIRECT /login")
  expect(mocks.transaction).not.toHaveBeenCalled()
})
it("support reads cannot use the customer application service", async () => {
  expect(
    (
      await runAccessCommand("customer", {
        workspaceId,
        operation: "support.read",
        payload: {
          grantId: workspaceId,
          resourceId: workspaceId,
          resourceType: "agent",
        },
      })
    ).ok
  ).toBe(false)
  expect(mocks.transaction).not.toHaveBeenCalled()
})
it("DB errors and private fields never escape into action feedback", async () => {
  mocks.query.mockRejectedValue(
    new Error("secret connection password and private email")
  )
  expect(
    await runAccessCommand("customer", {
      workspaceId,
      operation: "member.list",
      payload: {},
    })
  ).toEqual({ ok: false })
})
it("issues a random token once but passes only its hash to the database", async () => {
  const result = await issueWorkspaceInvitation({
    workspaceId,
    email: "invitee@example.invalid",
    role: "member",
  })
  expect(result.ok).toBe(true)
  if (!result.ok || !("token" in result)) throw new Error("Expected token")
  expect(result.token).toMatch(/^[a-f0-9]{64}$/)
  const args = mocks.query.mock.calls[0]!
  expect(JSON.stringify(args)).not.toContain(result.token)
  expect(JSON.stringify(args)).toContain(
    createHash("sha256").update(result.token).digest("hex")
  )
  // An invitation is an activation link: valid for 48 hours at most (§87).
  const expiresAt = Date.parse(
    JSON.stringify(args).match(/"expiresAt\\?":\\?"([^"\\]+)/)![1]!
  )
  expect(expiresAt - Date.now()).toBeGreaterThan(47 * 3600_000)
  expect(expiresAt - Date.now()).toBeLessThanOrEqual(48 * 3600_000)
})
it("acceptance takes no caller-supplied email and hashes the token before querying", async () => {
  const token = "a".repeat(64)
  expect(
    (
      await acceptWorkspaceInvitation({
        workspaceId,
        token,
        email: "forged@example.invalid",
      })
    ).ok
  ).toBe(false)
  expect(mocks.transaction).not.toHaveBeenCalled()
  // A name is required (N7), and it is saved in the acceptance's transaction.
  expect((await acceptWorkspaceInvitation({ workspaceId, token })).ok).toBe(
    false
  )
  mocks.query
    .mockResolvedValueOnce([
      { result: { ok: true, id: workspaceId, data: null } },
    ])
    .mockResolvedValueOnce([{ ok: true }])
  expect(
    (
      await acceptWorkspaceInvitation({
        workspaceId,
        token,
        displayName: "  Ana Pérez ",
      })
    ).ok
  ).toBe(true)
  expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(token)
  expect(JSON.stringify(mocks.query.mock.calls.at(-1))).toContain("Ana Pérez")
  expect(mocks.transaction).toHaveBeenCalledWith(
    authId,
    workspaceId,
    expect.any(Function),
    "verified@example.invalid"
  )
  // If the name cannot be saved, nothing is accepted.
  mocks.query
    .mockResolvedValueOnce([
      { result: { ok: true, id: workspaceId, data: null } },
    ])
    .mockResolvedValueOnce([{ ok: false }])
  expect(
    (
      await acceptWorkspaceInvitation({
        workspaceId,
        token,
        displayName: "Ana",
      })
    ).ok
  ).toBe(false)
})
