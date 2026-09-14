import "server-only"
import { randomUUID } from "node:crypto"
import {
  authoringCommand,
  agentListing,
  editableDraftContent,
  authoringResult,
  workspaceView,
  agentView,
  reviewQueue,
  reviewView,
  type AuthoringCommand,
} from "@agentonic/contracts/authoring"
import { uuid, type AppKind } from "@agentonic/contracts/identity"
import { withIdentity } from "@agentonic/database/client"
import { requireVerifiedUser } from "./auth"
export async function runAuthoringCommand(app: AppKind, input: unknown) {
  const parsed = authoringCommand.safeParse(input)
  if (
    !parsed.success ||
    (parsed.data.operation.startsWith("review.") && app !== "admin")
  )
    return { ok: false as const }
  const actor = await requireVerifiedUser(app)
  try {
    return await withIdentity(
      actor.authId,
      parsed.data.workspaceId,
      async (tx) => {
        const result = await tx.$queryRaw<
          { result: unknown }[]
        >`SELECT agentonic.authoring_command(${parsed.data.operation}::text,${JSON.stringify(parsed.data.payload)}::jsonb,${randomUUID()}::uuid) result`
        const response = authoringResult.parse(result[0]?.result)
        if (parsed.data.operation !== "detail" || !response.ok) return response
        const view = agentView.parse(response.data)
        // Reuse the detail transaction's workspace read lock and RLS context.
        // Eligibility comes from each immutable snapshot, not the current form.
        const candidates = await tx.$queryRaw<
          {
            id: string
            codeReleaseId: string
            eligible: boolean
            content: unknown
          }[]
        >`
          SELECT r.id, r.code_release_id AS "codeReleaseId", r.content,
            (r.retired_at IS NULL AND agentonic.can_use_code(r.code_release_id)
             AND NOT EXISTS (SELECT 1 FROM agentonic.agent_submissions s WHERE s.workspace_id=r.workspace_id AND s.configuration_release_id=r.id)
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c(id) WHERE NOT agentonic.can_collection(c.id::uuid,'read'))) AS eligible
          FROM agentonic.configuration_releases r
          WHERE r.workspace_id=${parsed.data.workspaceId}::uuid AND r.agent_id=${parsed.data.payload.agentId}::uuid`
        const details = new Map(
          candidates.map((candidate) => [candidate.id, candidate])
        )
        return {
          ...response,
          data: {
            ...view,
            candidates: view.candidates.map((candidate) => {
              const detail = details.get(candidate.id)
              return {
                ...candidate,
                codeReleaseId: detail?.codeReleaseId ?? null,
                canSubmit:
                  !!detail?.eligible &&
                  editableDraftContent.safeParse(detail.content).success,
              }
            }),
          },
        }
      },
      actor.email
    )
  } catch {
    return { ok: false as const }
  }
}
export async function loadWorkspace(workspaceId: string) {
  const r = await runAuthoringCommand("customer", {
    operation: "list",
    workspaceId,
    payload: {},
  })
  if (!r.ok) return null
  const result = workspaceView.safeParse(r.data)
  return result.success ? result.data : null
}
export async function loadAgent(workspaceId: string, agentId: string) {
  const r = await runAuthoringCommand("customer", {
    operation: "detail",
    workspaceId,
    payload: { agentId },
  })
  if (!r.ok) return null
  const result = agentView.safeParse(r.data)
  return result.success ? result.data : null
}
export async function loadReviewQueue(workspaceId: string) {
  const r = await runAuthoringCommand("admin", {
    operation: "review.queue",
    workspaceId,
    payload: {},
  })
  if (!r.ok) return null
  const result = reviewQueue.safeParse(r.data)
  return result.success ? result.data : null
}
export async function openReview(
  workspaceId: string,
  submissionId: string,
  grantId: string
) {
  const r = await runAuthoringCommand("admin", {
    operation: "review.read",
    workspaceId,
    payload: { submissionId, grantId },
  })
  if (!r.ok) return null
  const result = reviewView.safeParse(r.data)
  return result.success ? result.data : null
}
export async function reviewWorkspaces() {
  const actor = await requireVerifiedUser("admin")
  try {
    return await withIdentity(actor.authId, null, async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; name: string }[]
      >`SELECT * FROM agentonic.review_workspaces()`
      return rows.filter((row) => uuid.safeParse(row.id).success)
    })
  } catch {
    return null
  }
}
export type CustomerAuthoringCommand = Exclude<
  AuthoringCommand,
  { operation: `review.${string}` }
>

export async function loadAgentListing(workspaceId: string) {
  const actor = await requireVerifiedUser("customer")
  return withIdentity(
    actor.authId,
    workspaceId,
    async (tx) => {
      const rows = await tx.$queryRaw<
        { result: unknown }[]
      >`SELECT agentonic.agent_listing() result`
      return agentListing.parse(rows[0]?.result)
    },
    actor.email
  )
}
