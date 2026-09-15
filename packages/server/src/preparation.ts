import "server-only"
import {
  editableDraftContent,
  requestedAccess,
  type FormResult,
} from "@agentonic/contracts/authoring"
import { previewErrors, previewStartResult } from "@agentonic/contracts/preview"
import { preparationInput } from "@agentonic/contracts/workflow"
import { loadAgent, runAuthoringCommand } from "./authoring"
import { runPreviewCommand } from "./preview"

// Engine selection is server-owned. Opening a previous version never freezes
// the current draft or substitutes another candidate if that version is unavailable.
export async function prepareAgentPreview(
  workspaceId: string,
  agentId: string,
  input: unknown
): Promise<FormResult> {
  const parsed = preparationInput.safeParse(input)
  if (!parsed.success)
    return { ok: false, message: "Comprueba la revisión guardada." }
  const agent = await loadAgent(workspaceId, agentId)
  if (!agent || agent.draft.revision !== parsed.data.revision)
    return {
      ok: false,
      message:
        "El borrador cambió. Recarga la página antes de preparar o probar una versión.",
    }
  let candidateId = parsed.data.candidateId
  if (candidateId) {
    if (!agent.candidates.some((c) => c.id === candidateId && c.canPreview))
      return {
        ok: false,
        message: "Esta versión ya no está disponible para probar.",
      }
  } else {
    if (
      !editableDraftContent.safeParse(agent.draft.content).success ||
      !requestedAccess.safeParse(agent.draft.requestedAccess).success
    )
      return {
        ok: false,
        message:
          "Completa las instrucciones y guarda el borrador antes de preparar una versión.",
      }
    const codeReleaseId = agent.preparationCodeReleaseId
    if (!codeReleaseId)
      return {
        ok: false,
        message:
          "Agentonic todavía no ha habilitado las pruebas para este agente.",
      }
    const existing = agent.candidates.find(
      (c) =>
        c.revision === agent.draft.revision && c.codeReleaseId === codeReleaseId
    )
    if (existing) {
      if (!existing.canPreview)
        return {
          ok: false,
          message: "Esta versión ya no está disponible para probar.",
        }
      candidateId = existing.id
    } else {
      const frozen = await runAuthoringCommand("customer", {
        workspaceId,
        operation: "candidate.freeze",
        payload: { agentId, revision: parsed.data.revision, codeReleaseId },
      })
      if (!frozen.ok || !frozen.id)
        return {
          ok: false,
          message:
            "No se pudo preparar la versión. Comprueba el borrador guardado y tus permisos.",
        }
      candidateId = frozen.id
    }
  }
  const result = await runPreviewCommand(workspaceId, {
    operation: "start",
    payload: { agentId, candidateId },
  })
  const started = previewStartResult.safeParse(result)
  if (!started.success || !started.data.ok) {
    const code =
      started.success && !started.data.ok ? started.data.code : "unavailable"
    return {
      ok: false,
      message: `La versión se conserva. ${previewErrors[code ?? "unavailable"] ?? previewErrors.unavailable}`,
    }
  }
  return {
    ok: true,
    message: "Versión lista para probar. Todavía no ha sido evaluada.",
    href: `/agents/${agentId}/preview?workspace=${workspaceId}&candidate=${candidateId}&preview=${started.data.id}`,
  }
}
