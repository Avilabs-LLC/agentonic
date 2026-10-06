import { z } from "zod"

// What is in use and what comes next for one agent (architecture §55),
// derived from deployments, proposals and approvals. Metadata only.
const environment = z.enum(["local", "azure_staging"])
const count = z.coerce.number().int()
export const agentVersionSummary = z.object({
  archived: z.boolean(),
  // Running deployments, the VM first. Status is running, offline or
  // unauthorized (running without a valid authorization).
  live: z.array(
    z.object({
      environment,
      status: z.string(),
      resting: z.boolean(),
      versionNumber: count,
      submissionId: z.uuid(),
    })
  ),
  // The latest deployment when nothing runs and it stopped or failed.
  ended: z
    .object({ environment, status: z.string(), versionNumber: count })
    .nullable(),
  // The newest proposal for a version newer than the running one, with its
  // pending deployment (awaiting activation, queued, preparing or
  // unauthorized) when one is on the way.
  next: z
    .object({
      submissionId: z.uuid(),
      number: count,
      versionNumber: count,
      status: z.string(),
      approvalReason: z.string().nullable(),
      approvalExpiresAt: z.string().nullable(),
      deployment: z.object({ environment, status: z.string() }).nullable(),
    })
    .nullable(),
})
export type AgentVersionSummary = z.infer<typeof agentVersionSummary>
