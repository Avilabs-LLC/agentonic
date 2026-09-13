import "server-only"
import { authClient } from "./auth"
import {
  signInSchema,
  type AppKind,
  type ActionResult,
} from "@agentonic/contracts/identity"
export async function passwordSignIn(
  app: AppKind,
  input: unknown
): Promise<ActionResult> {
  const parsed = signInSchema.safeParse(input)
  if (!parsed.success)
    return { ok: false, message: "Revisa el correo y la contraseña." }
  try {
    const client = await authClient(app)
    const { data, error } = await client.auth.signInWithPassword(parsed.data)
    if (error || !data.user?.email_confirmed_at)
      return {
        ok: false,
        message:
          "No se pudo iniciar sesión. Revisa tus datos y confirma tu correo.",
      }
    return { ok: true }
  } catch {
    return { ok: false, message: "No se pudo conectar. Inténtalo de nuevo." }
  }
}
export async function signOut(app: AppKind): Promise<ActionResult> {
  try {
    const { error } = await (
      await authClient(app)
    ).auth.signOut({ scope: "local" })
    return error
      ? {
          ok: false,
          message: "No se pudo cerrar la sesión. Inténtalo de nuevo.",
        }
      : { ok: true }
  } catch {
    return {
      ok: false,
      message: "No se pudo cerrar la sesión. Inténtalo de nuevo.",
    }
  }
}
