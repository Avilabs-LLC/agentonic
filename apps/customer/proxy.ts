import { refreshSession } from "@agentonic/server/proxy"
import { siteRewrite } from "@agentonic/contracts/site"
import type { NextRequest } from "next/server"
export function proxy(request: NextRequest) {
  // The public site's host shows the site at its root (architecture §85).
  return refreshSession(
    request,
    "customer",
    siteRewrite(request.headers.get("host"), request.nextUrl.pathname)
  )
}
export const config = {
  matcher: ["/((?!api/health|_next/static|_next/image|favicon.ico).*)"],
}
