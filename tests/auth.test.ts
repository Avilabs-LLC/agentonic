import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  overview: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: mocks.getUser,
      signInWithPassword: mocks.signIn,
      signOut: mocks.signOut,
    },
  }),
}))
vi.mock("next/headers", () => ({
  cookies: async () => ({ getAll: () => [], set: vi.fn() }),
}))
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error("REDIRECT " + path)
  },
}))
vi.mock("@agentonic/database/client", () => ({
  identityOverview: mocks.overview,
}))
import { requireIdentity } from "../packages/server/src/auth"
import { passwordSignIn } from "../packages/server/src/actions"
beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co")
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-public-key")
})
it("rejects unverifiable sessions before database access", async () => {
  mocks.getUser.mockResolvedValue({
    data: { user: null },
    error: new Error("expired"),
  })
  await expect(requireIdentity("admin")).rejects.toThrow("REDIRECT /login")
  expect(mocks.overview).not.toHaveBeenCalled()
})
it("requires confirmed email even with a valid Auth identity", async () => {
  mocks.getUser.mockResolvedValue({
    data: {
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email_confirmed_at: null,
      },
    },
    error: null,
  })
  await expect(requireIdentity("customer")).rejects.toThrow("REDIRECT /login")
  expect(mocks.overview).not.toHaveBeenCalled()
})
it("derives identity from Auth; a customer session never gains admin access", async () => {
  mocks.getUser.mockResolvedValue({
    data: {
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email_confirmed_at: "2026-09-13",
        email: "synthetic@example.test",
      },
    },
    error: null,
  })
  mocks.overview.mockResolvedValue({
    user: { id: "user" },
    staff: null,
    workspaces: [{ id: "workspace" }],
  })
  expect((await requireIdentity("admin")).hasAccess).toBe(false)
  expect((await requireIdentity("customer")).hasAccess).toBe(true)
  expect(mocks.overview).toHaveBeenCalledWith(
    "11111111-1111-4111-8111-111111111111"
  )
})
it("staff access does not imply customer workspace access", async () => {
  mocks.getUser.mockResolvedValue({
    data: {
      user: {
        id: "11111111-1111-4111-8111-111111111111",
        email_confirmed_at: "2026-09-13",
      },
    },
    error: null,
  })
  mocks.overview.mockResolvedValue({
    user: { id: "user" },
    staff: { role: "administrator" },
    workspaces: [],
  })
  expect((await requireIdentity("admin")).hasAccess).toBe(true)
  expect((await requireIdentity("customer")).hasAccess).toBe(false)
})
it("rejects malformed sign-in server-side before contacting Auth", async () => {
  expect(
    (await passwordSignIn("admin", { email: "bad", password: "" })).ok
  ).toBe(false)
  expect(mocks.signIn).not.toHaveBeenCalled()
})
it("does not expose provider errors or credentials in login feedback", async () => {
  mocks.signIn.mockResolvedValue({
    data: { user: null },
    error: new Error("sensitive provider error"),
  })
  const response = await passwordSignIn("customer", {
    email: "synthetic@example.test",
    password: "synthetic",
  })
  expect(response.ok).toBe(false)
  expect(JSON.stringify(response)).not.toContain("sensitive")
})
