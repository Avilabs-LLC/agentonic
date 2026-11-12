import "server-only"
import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { authConfiguration } from "./env"
import { contentSecurityPolicy, nonce, securityHeaders } from "./security"
import type { AppKind } from "@agentonic/contracts/identity"
type Cookie = Parameters<NextResponse["cookies"]["set"]>
export async function refreshSession(request: NextRequest, app: AppKind) {
  const { url, key, cookieOptions } = authConfiguration(app)
  const refreshed = new Map<string, Cookie>()
  const client = createServerClient(url, key, {
    cookieOptions,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values) {
        values.forEach(({ name, value, options }) => {
          request.cookies.set(name, value)
          refreshed.set(name, [name, value, options])
        })
      },
    },
  })
  await client.auth.getClaims()
  const production = process.env.NODE_ENV === "production"
  // Pages get a per-request nonce that Next.js puts on its own scripts. API
  // responses set their own policies (document downloads are sandboxed).
  const policy =
    production && !request.nextUrl.pathname.startsWith("/api/")
      ? contentSecurityPolicy(nonce())
      : null
  // Forward the refreshed cookies, and the policy Next.js reads the nonce from.
  const headers = new Headers(request.headers)
  if (policy) headers.set("Content-Security-Policy", policy)
  // The page asked for, so the second-factor step can return to it (§87).
  // Always set here, so a browser cannot supply its own.
  headers.set(
    "x-agentonic-path",
    request.nextUrl.pathname + request.nextUrl.search
  )
  const response = NextResponse.next({ request: { headers } })
  refreshed.forEach((cookie) => response.cookies.set(...cookie))
  if (policy) response.headers.set("Content-Security-Policy", policy)
  for (const [name, value] of securityHeaders(production, app))
    response.headers.set(name, value)
  response.headers.set("Cache-Control", "private, no-store")
  return response
}
