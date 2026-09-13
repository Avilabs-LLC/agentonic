import { refreshSession } from "@agentonic/server/proxy"
import type { NextRequest } from "next/server"
export function proxy(request: NextRequest) {
  return refreshSession(request, "admin")
}
export const config = {
  matcher: ["/((?!api/health|_next/static|_next/image|favicon.ico).*)"],
}
