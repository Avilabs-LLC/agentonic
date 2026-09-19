import { z } from "zod"

export const webGrant = z
  .object({
    capability: z.literal("web"),
    operations: z.tuple([z.literal("web.search"), z.literal("web.read")]),
  })
  .strict()
export const WEB_GRANT: z.infer<typeof webGrant> = {
  capability: "web",
  operations: ["web.search", "web.read"],
}
export const webArguments = {
  "web.search": z.object({ query: z.string().trim().min(1).max(200) }).strict(),
  "web.read": z.object({ url: z.string().min(1).max(2048) }).strict(),
} as const
export type WebOperation = keyof typeof webArguments
// Conservative public overage estimates, not a claim about the account invoice.
export const webCostMicrousd = { "web.search": 7000, "web.read": 4000 } as const
