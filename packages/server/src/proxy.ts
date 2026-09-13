import "server-only"
import { createServerClient } from "@supabase/ssr"
import { NextResponse, type NextRequest } from "next/server"
import { authConfiguration } from "./env"
import type { AppKind } from "@agentonic/contracts/identity"
export async function refreshSession(request: NextRequest, app: AppKind) {
  let response = NextResponse.next({ request })
  const { url, key, cookieOptions } = authConfiguration(app)
  const client = createServerClient(url, key, {
    cookieOptions,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(values) {
        values.forEach(({ name, value }) => request.cookies.set(name, value))
        response = NextResponse.next({ request })
        values.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options)
        )
      },
    },
  })
  await client.auth.getClaims()
  response.headers.set("Cache-Control", "private, no-store")
  return response
}
