import "server-only"
import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { authConfiguration } from "./env"
import { identityOverview } from "@agentonic/database/client"
import { uuid, type AppKind } from "@agentonic/contracts/identity"

export async function authClient(app: AppKind) {
  const cookieStore = await cookies()
  const { url, key, cookieOptions } = authConfiguration(app)
  return createServerClient(url, key, {
    cookieOptions,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll(values) {
        try {
          values.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options)
          )
        } catch {
          /* Server Components cannot write cookies; proxy refreshes before render. */
        }
      },
    },
  })
}
export async function requireVerifiedUser(app: AppKind) {
  const client = await authClient(app)
  // Server-verified identity; cookie/session payloads and form fields never establish identity.
  const { data, error } = await client.auth.getUser()
  if (error || !data.user || !data.user.email_confirmed_at) redirect("/login")
  const authId = uuid.parse(data.user.id)
  return { authId, email: data.user.email ?? "" }
}
export async function requireIdentity(app: AppKind) {
  const verified = await requireVerifiedUser(app)
  const overview = await identityOverview(verified.authId)
  return {
    ...overview,
    email: verified.email,
    hasAccess:
      app === "admin"
        ? Boolean(overview.staff)
        : Boolean(overview.user && overview.workspaces.length),
  }
}
