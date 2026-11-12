import { beforeEach, expect, it, vi } from "vitest"
import {
  nameRequired,
  PLACEHOLDER_NAME,
  safeNext,
} from "../packages/contracts/src/identity"

// Account flows (architecture §54): email links, password reset, invitation
// emails and the staff authenticator, with Supabase replaced by fakes.
const mocks = vi.hoisted(() => ({
  verifyOtp: vi.fn(),
  updateUser: vi.fn(),
  reset: vi.fn(),
  otp: vi.fn(),
  issue: vi.fn(),
  command: vi.fn(),
  accept: vi.fn(),
  setName: vi.fn(),
  listFactors: vi.fn(),
  enroll: vi.fn(),
  unenroll: vi.fn(),
  challengeAndVerify: vi.fn(),
  aal: vi.fn(),
  mailApp: vi.fn(),
  issueStaff: vi.fn(),
  staffCommand: vi.fn(),
}))
vi.mock("server-only", () => ({}))
vi.mock("../packages/server/src/auth", () => ({
  mailClient: (app: string) => {
    mocks.mailApp(app)
    return {
      auth: { resetPasswordForEmail: mocks.reset, signInWithOtp: mocks.otp },
    }
  },
  authClient: async () => ({
    auth: {
      verifyOtp: mocks.verifyOtp,
      updateUser: mocks.updateUser,
      mfa: {
        listFactors: mocks.listFactors,
        enroll: mocks.enroll,
        unenroll: mocks.unenroll,
        challengeAndVerify: mocks.challengeAndVerify,
        getAuthenticatorAssuranceLevel: mocks.aal,
      },
    },
  }),
  requireVerifiedUser: async () => ({ authId: "a", email: "a@example.test" }),
  requirePasswordSession: async () => ({
    authId: "a",
    email: "a@example.test",
  }),
}))
vi.mock("../packages/server/src/access", () => ({
  issueWorkspaceInvitation: mocks.issue,
  runAccessCommand: mocks.command,
  acceptWorkspaceInvitation: mocks.accept,
  setOwnDisplayName: mocks.setName,
  issueStaffInvitation: mocks.issueStaff,
  runStaffCommand: mocks.staffCommand,
}))
import {
  changePassword,
  confirmEmailLink,
  inviteMember,
  inviteStaff,
  requestPasswordReset,
  secondFactorStep,
  startAuthenticator,
  updateDisplayName,
  verifyAuthenticator,
} from "../packages/server/src/account"
import { publicUrl } from "../packages/server/src/env"

const workspace = "11111111-1111-4111-8111-111111111111"
const invitation = "22222222-2222-4222-8222-222222222222"
const token = "ab".repeat(32)
beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co")
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-public-key")
  vi.stubEnv("AGENTONIC_PUBLIC_URL", "https://app.example.test")
})

it("follows only paths on this app after a link or sign-in", () => {
  expect(safeNext("/invitation?workspace=w&token=t")).toBe(
    "/invitation?workspace=w&token=t"
  )
  for (const unsafe of [
    "//evil.example",
    "https://evil.example/",
    "/\\evil.example",
    "/ok\nSet-Cookie: x",
    "relative",
    undefined,
    42,
  ])
    expect(safeNext(unsafe)).toBe("/")
  expect(safeNext("//evil.example", "/password")).toBe("/password")
})

it("builds email links from configuration, never from the request", () => {
  vi.unstubAllEnvs()
  expect(publicUrl("admin")).toBe("http://localhost:3100")
  expect(publicUrl("customer")).toBe("http://localhost:3101")
  vi.stubEnv("AGENTONIC_PUBLIC_URL", "https://admin.example.test")
  expect(publicUrl("admin")).toBe("https://admin.example.test")
  for (const bad of ["http://admin.example.test", "https://x.test/path"]) {
    vi.stubEnv("AGENTONIC_PUBLIC_URL", bad)
    expect(() => publicUrl("admin")).toThrow()
  }
})

it("signs in from an email link and goes only where it was meant to", async () => {
  mocks.verifyOtp.mockResolvedValue({ error: null })
  const confirm = (query: string) =>
    confirmEmailLink(
      "customer",
      new Request(`https://attacker.example/auth/confirm?${query}`)
    )
  const hash = "a".repeat(56)
  let response = await confirm(
    `token_hash=${hash}&type=email&next=${encodeURIComponent(`/invitation?workspace=${workspace}&token=${token}`)}`
  )
  expect(mocks.verifyOtp).toHaveBeenCalledWith({
    type: "email",
    token_hash: hash,
  })
  expect(response.status).toBe(303)
  expect(response.headers.get("location")).toBe(
    `https://app.example.test/invitation?workspace=${workspace}&token=${token}`
  )
  response = await confirm(`token_hash=${hash}&type=recovery`)
  expect(response.headers.get("location")).toBe(
    "https://app.example.test/password"
  )
  response = await confirm(`token_hash=${hash}&type=email&next=//evil.example`)
  expect(response.headers.get("location")).toBe("https://app.example.test/")
  for (const query of [
    `token_hash=${hash}&type=signup`,
    `token_hash=short&type=email`,
    `type=email`,
  ]) {
    response = await confirm(query)
    expect(response.headers.get("location")).toBe(
      "https://app.example.test/login?enlace=invalido"
    )
  }
  mocks.verifyOtp.mockResolvedValue({ error: { message: "expired" } })
  response = await confirm(`token_hash=${hash}&type=email`)
  expect(response.headers.get("location")).toBe(
    "https://app.example.test/login?enlace=invalido"
  )
  // An expired invitation link still leads to the invitation after signing in.
  response = await confirm(
    `token_hash=${hash}&type=email&next=${encodeURIComponent("/invitation?workspace=w&token=t")}`
  )
  expect(response.headers.get("location")).toBe(
    `https://app.example.test/login?enlace=invalido&next=${encodeURIComponent("/invitation?workspace=w&token=t")}`
  )
})

it("answers a reset request the same way whether or not the account exists", async () => {
  mocks.reset.mockResolvedValue({ data: {}, error: null })
  expect(
    await requestPasswordReset("customer", { email: "a@example.test" })
  ).toEqual({ ok: true })
  expect(mocks.reset).toHaveBeenCalledWith("a@example.test", {
    redirectTo: "https://app.example.test/auth/confirm?next=%2Fpassword",
  })
  mocks.reset.mockResolvedValue({ data: {}, error: { status: 400 } })
  expect(
    await requestPasswordReset("customer", { email: "nobody@example.test" })
  ).toEqual({ ok: true })
  mocks.reset.mockResolvedValue({ data: {}, error: { status: 429 } })
  expect(
    await requestPasswordReset("customer", { email: "a@example.test" })
  ).toMatchObject({ ok: false })
  expect(
    await requestPasswordReset("customer", { email: "not-an-email" })
  ).toMatchObject({ ok: false })
})

it("emails an invitation link that carries the one-time token, and withdraws the invitation when no email goes out", async () => {
  mocks.issue.mockResolvedValue({ ok: true, id: invitation, data: null, token })
  mocks.otp.mockResolvedValue({ data: {}, error: null })
  const input = {
    workspaceId: workspace,
    email: "nuevo@example.test",
    role: "member",
  }
  expect(await inviteMember(input)).toEqual({ ok: true })
  expect(mocks.otp).toHaveBeenCalledWith({
    email: "nuevo@example.test",
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `https://app.example.test/auth/confirm?next=${encodeURIComponent(`/invitation?workspace=${workspace}&token=${token}`)}`,
    },
  })
  expect(mocks.command).not.toHaveBeenCalled()

  mocks.otp.mockResolvedValue({ data: {}, error: { status: 429 } })
  const refused = await inviteMember(input)
  expect(refused).toMatchObject({ ok: false })
  expect(mocks.command).toHaveBeenCalledWith("customer", {
    workspaceId: workspace,
    operation: "invite.revoke",
    payload: { invitationId: invitation },
  })

  // Without authority the database issues nothing and no email is sent.
  mocks.otp.mockClear()
  mocks.issue.mockResolvedValue({ ok: false })
  expect(await inviteMember(input)).toMatchObject({ ok: false })
  expect(mocks.otp).not.toHaveBeenCalled()
  expect(await inviteMember({ ...input, role: "owner" })).toMatchObject({
    ok: false,
  })
})

it("emails a team invitation from Admin's mailer to Admin's /invitation, and withdraws it when no email goes out", async () => {
  mocks.issueStaff.mockResolvedValue({
    ok: true,
    id: invitation,
    data: null,
    token,
  })
  mocks.otp.mockResolvedValue({ data: {}, error: null })
  const input = { email: "equipo@example.test", role: "operator" }
  expect(await inviteStaff(input)).toEqual({ ok: true })
  expect(mocks.mailApp).toHaveBeenCalledWith("admin")
  expect(mocks.otp).toHaveBeenCalledWith({
    email: "equipo@example.test",
    options: {
      shouldCreateUser: true,
      emailRedirectTo: `https://app.example.test/auth/confirm?next=${encodeURIComponent(`/invitation?token=${token}`)}`,
    },
  })
  expect(mocks.staffCommand).not.toHaveBeenCalled()

  mocks.otp.mockResolvedValue({ data: {}, error: { status: 500 } })
  expect(await inviteStaff(input)).toMatchObject({
    ok: false,
    message: expect.stringContaining("la invitación se retiró"),
  })
  expect(mocks.staffCommand).toHaveBeenCalledWith("invite.revoke", {
    invitationId: invitation,
  })

  // Without authority nothing is issued and no email is sent; billing is never offered.
  mocks.otp.mockClear()
  mocks.issueStaff.mockResolvedValue({ ok: false })
  expect(await inviteStaff(input)).toMatchObject({ ok: false })
  expect(mocks.otp).not.toHaveBeenCalled()
  mocks.issueStaff.mockClear()
  expect(await inviteStaff({ ...input, role: "billing" })).toMatchObject({
    ok: false,
  })
  expect(mocks.issueStaff).not.toHaveBeenCalled()
})

it("explains password changes Supabase refuses", async () => {
  mocks.updateUser.mockResolvedValue({ error: null })
  const input = { password: "una-clave-larga", confirmation: "una-clave-larga" }
  expect(await changePassword("admin", input)).toEqual({ ok: true })
  mocks.updateUser.mockResolvedValue({ error: { code: "same_password" } })
  expect(await changePassword("admin", input)).toEqual({
    ok: false,
    message: "Elige una contraseña distinta de la actual.",
  })
  expect(
    await changePassword("admin", { password: "corta", confirmation: "corta" })
  ).toMatchObject({ ok: false })
  expect(mocks.updateUser).toHaveBeenCalledTimes(2)
})

it("verifies staff codes against their enrolled authenticator, and replaces abandoned enrolments", async () => {
  const verified = { id: "f-verified", status: "verified" }
  const abandoned = { id: "f-abandoned", status: "unverified" }
  mocks.listFactors.mockResolvedValue({
    data: { totp: [verified], all: [verified] },
  })
  mocks.challengeAndVerify.mockResolvedValue({ error: null })
  expect(await verifyAuthenticator({ code: "123456" })).toEqual({ ok: true })
  expect(mocks.challengeAndVerify).toHaveBeenCalledWith({
    factorId: "f-verified",
    code: "123456",
  })
  mocks.challengeAndVerify.mockResolvedValue({ error: { message: "bad" } })
  expect(await verifyAuthenticator({ code: "123456" })).toMatchObject({
    ok: false,
  })
  expect(await verifyAuthenticator({ code: "12a" })).toMatchObject({
    ok: false,
  })
  // A second enrolment is refused while one is active.
  expect(await startAuthenticator()).toMatchObject({ ok: false })
  mocks.listFactors.mockResolvedValue({
    data: { totp: [abandoned], all: [abandoned] },
  })
  mocks.enroll.mockResolvedValue({
    data: {
      id: "f-new",
      totp: { qr_code: "data:image/svg+xml;utf-8,<svg/>", secret: "S" },
    },
    error: null,
  })
  expect(await startAuthenticator()).toEqual({
    ok: true,
    factorId: "f-new",
    qrCode: "data:image/svg+xml;utf-8,<svg/>",
    secret: "S",
  })
  expect(mocks.unenroll).toHaveBeenCalledWith({ factorId: "f-abandoned" })
})
it("asks staff for a code, or to enrol one, until the session passed a second factor (§87)", async () => {
  const verified = { id: "f-verified", status: "verified" }
  mocks.aal.mockResolvedValue({ data: { currentLevel: "aal2" } })
  expect(await secondFactorStep()).toBe("verified")
  mocks.aal.mockResolvedValue({ data: { currentLevel: "aal1" } })
  mocks.listFactors.mockResolvedValue({
    data: { totp: [verified], all: [verified] },
  })
  expect(await secondFactorStep()).toBe("challenge")
  mocks.listFactors.mockResolvedValue({ data: { totp: [], all: [] } })
  expect(await secondFactorStep()).toBe("enrol")
  // Auth could not say: never treated as verified.
  mocks.aal.mockResolvedValue({ data: null })
  expect(await secondFactorStep()).toBe("enrol")
})
it("saves a person's own name only when it is a usable name (N7)", async () => {
  mocks.setName.mockResolvedValue(true)
  for (const displayName of ["   ", "x".repeat(121), "Ana\nBcc: x"])
    expect((await updateDisplayName("customer", { displayName })).ok).toBe(
      false
    )
  expect(mocks.setName).not.toHaveBeenCalled()
  expect(
    await updateDisplayName("admin", { displayName: "  Ana Pérez " })
  ).toEqual({ ok: true })
  expect(mocks.setName).toHaveBeenCalledWith("admin", "Ana Pérez")
  mocks.setName.mockResolvedValue(false)
  expect((await updateDisplayName("customer", { displayName: "Ana" })).ok).toBe(
    false
  )
})
it("asks for a name until the person chooses one other than the placeholder", async () => {
  expect(nameRequired({ displayName: PLACEHOLDER_NAME })).toBe(true)
  for (const user of [{ displayName: "Ana" }, { displayName: "Miembros" }, null])
    expect(nameRequired(user)).toBe(false)
  // Saving the placeholder would keep the prompt showing, so it is refused.
  mocks.setName.mockResolvedValue(true)
  for (const displayName of ["Miembro", " miembro ", "MIEMBRO"])
    expect(await updateDisplayName("customer", { displayName })).toEqual({
      ok: false,
      message: "Escribe tu nombre.",
    })
  expect(mocks.setName).not.toHaveBeenCalled()
})
