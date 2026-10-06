import { confirmEmailLink } from "@agentonic/server/account"
// Email links from Supabase Auth land here (architecture §54).
export function GET(request: Request) {
  return confirmEmailLink("admin", request)
}
