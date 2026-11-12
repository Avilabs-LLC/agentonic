import "server-only"
import { cache } from "react"
import { createServerClient } from "@supabase/ssr"
import { createClient } from "@supabase/supabase-js"
import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"
import { authConfiguration } from "./env"
import { identityOverview } from "@agentonic/database/client"
import { safeNext, uuid, type AppKind } from "@agentonic/contracts/identity"

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
// Deduplicate Auth verification only within one server render. Never cache sessions
// or database permission decisions across requests. Mutations recheck live DB authority.
async function verifiedUser(app: AppKind, secondFactor: boolean) {
  const client = await authClient(app)
  // Server-verified identity; cookie/session payloads and form fields never establish identity.
  const { data, error } = await client.auth.getUser()
  if (error || !data.user || !data.user.email_confirmed_at) redirect("/login")
  // Every staff session passes a second factor; staff without an authenticator
  // enrol one first (architecture §87). An unreadable level counts as missing.
  if (app === "admin" && secondFactor) {
    const { data: level } =
      await client.auth.mfa.getAuthenticatorAssuranceLevel()
    if (level?.currentLevel !== "aal2") {
      const here = safeNext((await headers()).get("x-agentonic-path"))
      redirect(here === "/" ? "/mfa" : `/mfa?next=${encodeURIComponent(here)}`)
    }
  }
  const authId = uuid.parse(data.user.id)
  return { authId, email: data.user.email ?? "" }
}
export const requireVerifiedUser = cache((app: AppKind) =>
  verifiedUser(app, true)
)
/** Signed in with a password, before any second factor: only the /mfa page uses this. */
export const requirePasswordSession = cache((app: AppKind) =>
  verifiedUser(app, false)
)
export const requireIdentity = cache(async (app: AppKind) => {
  const verified = await requireVerifiedUser(app)
  const overview = await identityOverview(verified.authId, verified.email)
  return {
    ...overview,
    email: verified.email,
    hasAccess:
      app === "admin"
        ? Boolean(overview.staff)
        : Boolean(overview.user && overview.workspaces.length),
  }
})
/** The signed-in, confirmed email, or null; for pages that also serve visitors. */
export async function signedInEmail(app: AppKind) {
  const { data, error } = await (await authClient(app)).auth.getUser()
  return error || !data.user?.email_confirmed_at
    ? null
    : (data.user.email ?? null)
}
/** A client that only asks Supabase Auth to send an email; it holds no session. */
export function mailClient(app: AppKind) {
  const { url, key } = authConfiguration(app)
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "implicit",
    },
  })
}
