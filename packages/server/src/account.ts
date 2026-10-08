import "server-only"
import { NextResponse } from "next/server"
import {
  displayNameSchema,
  emailOnlySchema,
  mfaCodeSchema,
  mfaEnrollmentCode,
  newPasswordSchema,
  safeNext,
  type ActionResult,
  type AppKind,
} from "@agentonic/contracts/identity"
import {
  invitationRevocation,
  memberInvitationInput,
  workspaceInvitations,
  workspaceMembers,
} from "@agentonic/contracts/access"
import {
  authClient,
  mailClient as mailer,
  requirePasswordSession,
  requireVerifiedUser,
} from "./auth"
import { publicUrl } from "./env"
import {
  acceptWorkspaceInvitation,
  issueWorkspaceInvitation,
  runAccessCommand,
  setOwnDisplayName,
} from "./access"

// Account flows (architecture §54). Supabase Auth sends every email through the
// owner's SMTP; its templates link back here with a token hash, so a link works
// in any browser. The apps hold no new secret: invitations, resets and sign-in
// links use the publishable key.

const confirmLink = (app: AppKind, next: string) =>
  `${publicUrl(app)}/auth/confirm?next=${encodeURIComponent(next)}`
const tooMany = (status?: number) => status === 429

/**
 * GET /auth/confirm: an email link signs in, then goes where it was meant to. A
 * link that no longer works leads to the login page, which keeps the destination,
 * so an invitee whose link expired still reaches the invitation after signing in.
 */
export async function confirmEmailLink(app: AppKind, request: Request) {
  const url = new URL(request.url)
  const tokenHash = url.searchParams.get("token_hash") ?? ""
  const type = url.searchParams.get("type")
  const base = publicUrl(app)
  const requested = safeNext(url.searchParams.get("next"), "")
  const invalid = NextResponse.redirect(
    `${base}/login?enlace=invalido${requested ? `&next=${encodeURIComponent(requested)}` : ""}`,
    303
  )
  if (
    !/^[A-Za-z0-9_-]{16,256}$/.test(tokenHash) ||
    (type !== "email" && type !== "recovery")
  )
    return invalid
  try {
    const client = await authClient(app)
    const { error } = await client.auth.verifyOtp({
      type,
      token_hash: tokenHash,
    })
    if (error) return invalid
  } catch {
    return invalid
  }
  const next = requested || (type === "recovery" ? "/password" : "/")
  return NextResponse.redirect(`${base}${next}`, 303)
}

/** The same answer whether or not the address has an account. */
export async function requestPasswordReset(
  app: AppKind,
  input: unknown
): Promise<ActionResult> {
  const parsed = emailOnlySchema.safeParse(input)
  if (!parsed.success)
    return { ok: false, message: "Introduce un correo válido." }
  try {
    const { error } = await mailer(app).auth.resetPasswordForEmail(
      parsed.data.email,
      { redirectTo: confirmLink(app, "/password") }
    )
    if (tooMany(error?.status))
      return {
        ok: false,
        message: "Pediste varios enlaces seguidos. Espera unos minutos.",
      }
  } catch {
    return { ok: false, message: "No se pudo conectar. Inténtalo de nuevo." }
  }
  return { ok: true }
}

export async function changePassword(
  app: AppKind,
  input: unknown
): Promise<ActionResult> {
  const parsed = newPasswordSchema.safeParse(input)
  if (!parsed.success)
    return { ok: false, message: "Revisa la contraseña y su confirmación." }
  await requireVerifiedUser(app)
  try {
    const { error } = await (
      await authClient(app)
    ).auth.updateUser({ password: parsed.data.password })
    if (!error) return { ok: true }
    const messages: Record<string, string> = {
      same_password: "Elige una contraseña distinta de la actual.",
      weak_password: "Esa contraseña es demasiado débil. Elige otra.",
      reauthentication_needed:
        "Vuelve a iniciar sesión y repite el cambio de contraseña.",
    }
    return {
      ok: false,
      message:
        messages[error.code ?? ""] ?? "No se pudo cambiar la contraseña.",
    }
  } catch {
    return { ok: false, message: "No se pudo conectar. Inténtalo de nuevo." }
  }
}

// Members and invitations (customer app) -----------------------------------------
export async function loadMembers(workspaceId: string) {
  const [members, invitations] = await Promise.all([
    runAccessCommand("customer", {
      workspaceId,
      operation: "member.list",
      payload: {},
    }),
    runAccessCommand("customer", {
      workspaceId,
      operation: "invite.list",
      payload: {},
    }),
  ])
  if (!members.ok || !invitations.ok) return null
  return {
    members: workspaceMembers.parse(members.data),
    invitations: workspaceInvitations.parse(invitations.data),
  }
}

/**
 * Records the invitation, then has Supabase email a sign-in link to the address.
 * The link returns to /invitation with the one-time token. A new address gets an
 * account only because this invitation is live (the database hook checks).
 */
export async function inviteMember(input: unknown): Promise<ActionResult> {
  const parsed = memberInvitationInput.safeParse(input)
  if (!parsed.success)
    return { ok: false, message: "Revisa el correo y el rol." }
  const issued = await issueWorkspaceInvitation(parsed.data)
  if (!issued.ok || !("token" in issued) || !issued.id)
    return {
      ok: false,
      message:
        "No se pudo crear la invitación. Solo propietarios y administradores invitan, y solo un propietario invita a un administrador.",
    }
  const { workspaceId, email } = parsed.data
  const next = `/invitation?workspace=${workspaceId}&token=${issued.token}`
  let status: number | undefined
  try {
    const { error } = await mailer("customer").auth.signInWithOtp({
      email,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: confirmLink("customer", next),
      },
    })
    if (!error) return { ok: true }
    status = error.status
  } catch {
    status = undefined
  }
  // No email went out: withdraw the invitation rather than leave it unreachable.
  await runAccessCommand("customer", {
    workspaceId,
    operation: "invite.revoke",
    payload: { invitationId: issued.id },
  })
  return {
    ok: false,
    message: tooMany(status)
      ? "Se enviaron demasiados correos seguidos. Espera unos minutos e inténtalo de nuevo."
      : "No se pudo enviar el correo, así que la invitación se retiró. Inténtalo de nuevo.",
  }
}

export async function revokeInvitation(input: unknown): Promise<ActionResult> {
  const parsed = invitationRevocation.safeParse(input)
  if (!parsed.success) return { ok: false, message: "Invitación no válida." }
  const result = await runAccessCommand("customer", {
    workspaceId: parsed.data.workspaceId,
    operation: "invite.revoke",
    payload: { invitationId: parsed.data.invitationId },
  })
  return result.ok
    ? { ok: true }
    : { ok: false, message: "No se pudo retirar la invitación." }
}

export async function updateDisplayName(
  app: AppKind,
  input: unknown
): Promise<ActionResult> {
  const parsed = displayNameSchema.safeParse(input)
  if (!parsed.success)
    return {
      ok: false,
      message: parsed.error.issues[0]?.message ?? "Nombre no válido.",
    }
  return (await setOwnDisplayName(app, parsed.data.displayName))
    ? { ok: true }
    : {
        ok: false,
        message: "No se pudo guardar tu nombre. Inténtalo de nuevo.",
      }
}

export async function acceptInvitation(input: unknown): Promise<ActionResult> {
  const result = await acceptWorkspaceInvitation(input)
  return result.ok
    ? { ok: true }
    : {
        ok: false,
        message:
          "No se pudo aceptar. La invitación venció, se retiró, ya se usó o es para otro correo.",
      }
}

// Authenticator app for staff (admin app) -----------------------------------------
async function verifiedTotp(app: AppKind) {
  const { data } = await (await authClient(app)).auth.mfa.listFactors()
  return data?.totp.find((factor) => factor.status === "verified") ?? null
}
export async function authenticatorState() {
  await requireVerifiedUser("admin")
  return { enabled: Boolean(await verifiedTotp("admin")) }
}
/** Starts enrolment; abandoned unverified factors are removed first. */
export async function startAuthenticator(): Promise<
  | { ok: true; factorId: string; qrCode: string; secret: string }
  | { ok: false; message: string }
> {
  await requireVerifiedUser("admin")
  try {
    const client = await authClient("admin")
    const { data: factors } = await client.auth.mfa.listFactors()
    if (factors?.totp.some((factor) => factor.status === "verified"))
      return {
        ok: false,
        message: "La verificación en dos pasos ya está activa.",
      }
    for (const factor of factors?.all ?? [])
      if (factor.status !== "verified")
        await client.auth.mfa.unenroll({ factorId: factor.id })
    const { data, error } = await client.auth.mfa.enroll({
      factorType: "totp",
      friendlyName: "Agentonic Admin",
      issuer: "Agentonic",
    })
    if (error || !data)
      return { ok: false, message: "No se pudo iniciar la activación." }
    return {
      ok: true,
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    }
  } catch {
    return { ok: false, message: "No se pudo conectar. Inténtalo de nuevo." }
  }
}
async function verifyCode(factorId: string, code: string) {
  const { error } = await (
    await authClient("admin")
  ).auth.mfa.challengeAndVerify({ factorId, code })
  return !error
}
/** Confirms enrolment with a first code; the session is then second-factor. */
export async function confirmAuthenticator(
  input: unknown
): Promise<ActionResult> {
  const parsed = mfaEnrollmentCode.safeParse(input)
  if (!parsed.success) return { ok: false, message: "Revisa el código." }
  await requireVerifiedUser("admin")
  try {
    return (await verifyCode(parsed.data.factorId, parsed.data.code))
      ? { ok: true }
      : { ok: false, message: "El código no es válido. Usa el más reciente." }
  } catch {
    return { ok: false, message: "No se pudo conectar. Inténtalo de nuevo." }
  }
}
/** The second step of signing in, for staff who enrolled. */
export async function verifyAuthenticator(
  input: unknown
): Promise<ActionResult> {
  const parsed = mfaCodeSchema.safeParse(input)
  if (!parsed.success) return { ok: false, message: "Revisa el código." }
  await requirePasswordSession("admin")
  try {
    const factor = await verifiedTotp("admin")
    if (!factor)
      return {
        ok: false,
        message: "No hay una aplicación de verificación activa.",
      }
    return (await verifyCode(factor.id, parsed.data.code))
      ? { ok: true }
      : { ok: false, message: "El código no es válido. Usa el más reciente." }
  } catch {
    return { ok: false, message: "No se pudo conectar. Inténtalo de nuevo." }
  }
}
/** Turning it off needs a session that already passed the second factor. */
export async function disableAuthenticator(): Promise<ActionResult> {
  await requireVerifiedUser("admin")
  try {
    const factor = await verifiedTotp("admin")
    if (!factor) return { ok: true }
    const { error } = await (
      await authClient("admin")
    ).auth.mfa.unenroll({ factorId: factor.id })
    return error
      ? {
          ok: false,
          message: "No se pudo desactivar. Vuelve a iniciar sesión.",
        }
      : { ok: true }
  } catch {
    return { ok: false, message: "No se pudo conectar. Inténtalo de nuevo." }
  }
}
/** Whether this session still owes its second factor. */
export async function secondFactorPending() {
  const { data } = await (
    await authClient("admin")
  ).auth.mfa.getAuthenticatorAssuranceLevel()
  return data?.nextLevel === "aal2" && data.currentLevel !== "aal2"
}
