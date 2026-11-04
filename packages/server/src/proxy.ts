import "server-only"
import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { authConfiguration } from "./env"
import { contentSecurityPolicy, nonce, securityHeaders } from "./security"
import type { AppKind } from "@agentonic/contracts/identity"
type Cookie = Parameters<NextResponse["cookies"]["set"]>
/**
 * Refreshes the session cookies and sets the response policies. `rewrite`
 * serves another path of the same app for this request (the public site's
 * host, architecture §85) without changing the address the browser shows.
 */
export async function refreshSession(
  request: NextRequest,
  app: AppKind,
  rewrite?: string | null
) {
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
  // The rewrite keeps the request's own URL and changes only its path: a URL
  // built from a different origin (behind the proxy, "https://localhost:3101")
  // would make Next.js proxy the request to that address over TLS and fail.
  let destination: URL | undefined
  if (rewrite) {
    destination = request.nextUrl.clone()
    destination.pathname = rewrite
  }
  const response = destination
    ? NextResponse.rewrite(destination, { request: { headers } })
    : NextResponse.next({ request: { headers } })
  refreshed.forEach((cookie) => response.cookies.set(...cookie))
  if (policy) response.headers.set("Content-Security-Policy", policy)
  for (const [name, value] of securityHeaders(production, app))
    response.headers.set(name, value)
  response.headers.set("Cache-Control", "private, no-store")
  return response
}
