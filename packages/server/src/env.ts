import "server-only"
import type { AppKind } from "@agentonic/contracts/identity"
export function authConfiguration(app: AppKind) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  if (!url || !key || !url.startsWith("https://"))
    throw new Error("Supabase configuration is missing.")
  return {
    url,
    key,
    cookieOptions: {
      name: `agentonic-${app}-auth`,
      httpOnly: true,
      sameSite: "lax" as const,
      secure: process.env.NODE_ENV === "production",
      path: "/",
    },
  }
}
/** The environment named in each page's header: hosted nonproduction says "Pruebas". */
export function environmentLabel() {
  return process.env.AGENTONIC_ENVIRONMENT === "staging"
    ? "Pruebas"
    : "Desarrollo"
}
