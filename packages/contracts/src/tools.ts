import { z } from "zod"
import { gmailGrant } from "./gmail"
import { webGrant } from "./web"

export const toolGrant = z.union([gmailGrant, webGrant])
export const toolGrants = z
  .array(toolGrant)
  .max(2)
  .refine(
    (grants) =>
      grants.filter((g) => "connectionId" in g).length <= 1 &&
      grants.filter((g) => "capability" in g).length <= 1
  )
export const gmailGrants = (grants: z.infer<typeof toolGrant>[]) =>
  grants.filter((g): g is z.infer<typeof gmailGrant> => "connectionId" in g)
export const hasWeb = (grants: z.infer<typeof toolGrant>[]) =>
  grants.some((g) => "capability" in g && g.capability === "web")
