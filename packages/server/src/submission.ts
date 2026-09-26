import "server-only"
import { randomUUID } from "node:crypto"
import { withIdentity } from "@agentonic/database/client"
import { uuid } from "@agentonic/contracts/identity"
import {
  agentView,
  authoringResult,
  editableDraftContent,
  requestedAccess,
  type FormResult,
} from "@agentonic/contracts/authoring"
import { submissionInput } from "@agentonic/contracts/workflow"
import { reviewFlowResult } from "@agentonic/contracts/review-flow"
import { requireVerifiedUser } from "./auth"

export async function submitAgentForReview(
  workspaceId: string,
  agentId: string,
  input: unknown
): Promise<FormResult> {
  const parsed = submissionInput.safeParse(input)
  if (
    !uuid.safeParse(workspaceId).success ||
    !uuid.safeParse(agentId).success ||
    !parsed.success
  )
    return {
      ok: false,
      message: "Revisa el límite de consumo y autoriza la revisión con IA.",
    }
  const actor = await requireVerifiedUser("customer")
  const { candidateId, note, consent, budgetUsd, revision, requestId } =
    parsed.data
  try {
    await withIdentity(
      actor.authId,
      workspaceId,
      async (tx) => {
        // The send command acquires the workspace write lock. Validate the saved
        // revision under that same lock; any failure rolls back BOTH operations.
        const sentRows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT agentonic.authoring_command('submission.send',${JSON.stringify({ candidateId, note, consent })}::jsonb,${randomUUID()}::uuid) result`
        const sent = authoringResult.parse(sentRows[0]?.result)
        if (!sent.ok || !sent.id) throw new Error("submission_denied")
        const detailRows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT agentonic.authoring_command('detail',${JSON.stringify({ agentId })}::jsonb,${randomUUID()}::uuid) result`
        const detail = authoringResult.parse(detailRows[0]?.result)
        if (!detail.ok) throw new Error("agent_unavailable")
        const agent = agentView.parse(detail.data)
        const candidate = agent.candidates[0]
        if (
          agent.agent.id !== agentId ||
          candidate?.id !== candidateId ||
          candidate.revision !== revision ||
          agent.draft.revision !== revision ||
          !editableDraftContent.safeParse(agent.draft.content).success ||
          !requestedAccess.safeParse(agent.draft.requestedAccess).success
        )
          throw new Error("stale_candidate")
        const preparedRows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT agentonic.review_flow_command('prepare',${JSON.stringify({ submissionId: sent.id, budgetUsd, consent, requestId })}::jsonb,${randomUUID()}::uuid) result`
        const prepared = reviewFlowResult.parse(preparedRows[0]?.result)
        if (!prepared.ok) throw new Error("preparation_denied")
      },
      actor.email
    )
    return {
      ok: true,
      message:
        "Versión enviada. Prepararemos los criterios dentro del límite autorizado.",
      href: `/agents/${agentId}?workspace=${workspaceId}&tab=propuestas`,
    }
  } catch {
    return {
      ok: false,
      message:
        "No se pudo confirmar el envío y la preparación. Revisa Propuestas antes de reintentar y comprueba que la versión siga vigente.",
    }
  }
}
