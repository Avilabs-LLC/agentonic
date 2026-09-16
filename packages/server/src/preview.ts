import "server-only"
import { withIdentity } from "@agentonic/database/client"
import { uuid } from "@agentonic/contracts/identity"
import { previewCommand, previewState } from "@agentonic/contracts/preview"
import { requireVerifiedUser } from "./auth"
export async function loadCandidatePreview(
  workspaceId: string,
  agentId: string,
  candidateId: string,
  previewId: string
) {
  if (
    ![workspaceId, agentId, candidateId, previewId].every(
      (id) => uuid.safeParse(id).success
    )
  )
    return null
  const actor = await requireVerifiedUser("customer")
  try {
    return await withIdentity(
      actor.authId,
      workspaceId,
      async (tx) => {
        const matches = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM agentonic.active_agent_previews(${agentId}::uuid)
        WHERE candidate_id=${candidateId}::uuid AND id=${previewId}::uuid`
        if (!matches.length) return null
        const rows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT agentonic.preview_command('state',${JSON.stringify({ agentId, previewId })}::jsonb) result`
        const state = previewState.safeParse(rows[0]?.result)
        return state.success ? state.data : null
      },
      actor.email
    )
  } catch {
    return null
  }
}
export async function runPreviewCommand(workspaceId: string, input: unknown) {
  const parsed = previewCommand.safeParse(input)
  if (!uuid.safeParse(workspaceId).success || !parsed.success) return null
  const actor = await requireVerifiedUser("customer")
  try {
    return await withIdentity(
      actor.authId,
      workspaceId,
      async (tx) => {
        const rows = await tx.$queryRaw<
          { result: unknown }[]
        >`SELECT agentonic.preview_command(${parsed.data.operation}::text,${JSON.stringify(parsed.data.payload)}::jsonb) result`
        return rows[0]?.result ?? null
      },
      actor.email
    )
  } catch {
    return null
  }
}
