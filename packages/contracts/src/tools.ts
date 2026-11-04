import { z } from "zod"
import { gmailVersionGrant } from "./gmail"
import { driveVersionGrant } from "./drive"
import { webGrant } from "./web"

export const toolGrant = z.union([
  gmailVersionGrant,
  driveVersionGrant,
  webGrant,
])
type ToolGrant = z.infer<typeof toolGrant>
// At most one Gmail account, one Drive account and web access per version.
export const toolGrants = z
  .array(toolGrant)
  .max(3)
  .refine(
    (grants) =>
      grants.filter((g) => "connectionId" in g).length <= 1 &&
      grants.filter((g) => "driveConnectionId" in g).length <= 1 &&
      grants.filter((g) => "capability" in g).length <= 1
  )
export const gmailGrants = (grants: ToolGrant[]) =>
  grants.filter(
    (g): g is Extract<ToolGrant, { connectionId: string | null }> =>
      "connectionId" in g
  )
export const driveGrants = (grants: ToolGrant[]) =>
  grants.filter(
    (g): g is Extract<ToolGrant, { driveConnectionId: string | null }> =>
      "driveConnectionId" in g
  )
export const hasWeb = (grants: ToolGrant[]) =>
  grants.some((g) => "capability" in g && g.capability === "web")
