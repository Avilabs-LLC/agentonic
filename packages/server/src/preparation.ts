import "server-only"
import {
  editableDraftContent,
  requestedAccess,
  type FormResult,
} from "@agentonic/contracts/authoring"
import { previewErrors, previewStartResult } from "@agentonic/contracts/preview"
import {
  preparationInput,
  previewOpeningInput,
} from "@agentonic/contracts/workflow"
import { loadAgent, runAuthoringCommand } from "./authoring"
import { runPreviewCommand } from "./preview"

// Preparing only freezes configuration. Opening a test always requires an
// explicit candidate and never freezes or substitutes another version.
export async function prepareAgentVersion(
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
        "El borrador cambió. Recarga la página antes de preparar una versión.",
    }
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
  if (existing && !existing.canPreview)
    return {
      ok: false,
      message: "Esta versión ya no está disponible para probar.",
    }
  if (!existing) {
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
  }
  return {
    ok: true,
    message: existing
      ? "Esta versión ya está preparada."
      : "Versión preparada.",
  }
}

export async function openAgentPreview(
  workspaceId: string,
  agentId: string,
  input: unknown
): Promise<FormResult> {
  const parsed = previewOpeningInput.safeParse(input)
  if (!parsed.success)
    return {
      ok: false,
      message: "Selecciona una versión preparada para probar.",
    }
  const agent = await loadAgent(workspaceId, agentId)
  const { candidateId } = parsed.data
  if (!agent || agent.draft.revision !== parsed.data.revision)
    return {
      ok: false,
      message:
        "El borrador cambió. Recarga la página antes de probar una versión.",
    }
  if (
    agent.candidates[0]?.id !== candidateId ||
    !agent.candidates[0].canPreview
  )
    return {
      ok: false,
      message: "Esta versión ya no está disponible para probar.",
    }
  const result = await runPreviewCommand(workspaceId, {
    operation: "start",
    payload: { agentId, candidateId, enableTools: true },
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
    message: "Prueba lista.",
    href: `/agents/${agentId}/preview?workspace=${workspaceId}&candidate=${candidateId}&preview=${started.data.id}`,
  }
}
