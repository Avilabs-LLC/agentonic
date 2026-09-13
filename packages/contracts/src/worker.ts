import { z } from "zod"
export const workerConfiguration = z.object({
  name: z.literal("agentonic-platform-worker"),
  enabled: z.literal(false),
})
// No queue consumer exists yet. Enabling work requires a reviewed lease/authorization implementation.
