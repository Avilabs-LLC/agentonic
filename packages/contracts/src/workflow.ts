import { z } from "zod"
import { uuid } from "./identity"
import {
  editableDraftContent,
  requestedAccess,
  type AgentView,
} from "./authoring"

export const draftEditorForm = z.object({
  content: editableDraftContent,
  collectionIds: requestedAccess.shape.collectionIds,
  tools: requestedAccess.shape.tools.optional(),
})
export type DraftFormValues = z.infer<typeof draftEditorForm>
export type DraftEditorStatus = {
  dirty: boolean
  valid: boolean
  pending: boolean
  editingSkill: boolean
}
export type Requirement = { label: string; met: boolean }
// Agent detail returns candidates newest first. Keep the agent's last used
// available engine across reloads and draft saves instead of resetting to the catalog.
// An explicit preferred capability family affects only the next preparation;
// previously frozen versions and previews retain their original engine.
export function defaultFreezeCode(
  candidates: AgentView["candidates"],
  availableCodeIds: string[],
  preferredCodeIds: string[] = []
) {
  const preferred = preferredCodeIds.filter((id) =>
    availableCodeIds.includes(id)
  )
  const eligible = preferred.length ? preferred : availableCodeIds
  return (
    candidates.find(
      (candidate) =>
        candidate.codeReleaseId && eligible.includes(candidate.codeReleaseId)
    )?.codeReleaseId ??
    eligible[0] ??
    ""
  )
}
export const preparationInput = z
  .object({
    revision: z.number().int().positive(),
  })
  .strict()
export const previewOpeningInput = preparationInput.extend({
  candidateId: uuid,
})
export function preparedVersionLabel(
  candidate: AgentView["candidates"][number]
) {
  return `Versión ${candidate.number ?? candidate.revision}`
}
export function reviewPreparation(
  draft: AgentView["draft"],
  candidates: AgentView["candidates"],
  codeReleaseId: string | null
) {
  return {
    current: candidates.find(
      (c) =>
        c.canPreview &&
        c.revision === draft.revision &&
        c.codeReleaseId === codeReleaseId
    ),
    previous: candidates.find((c) => c.canPreview),
  }
}
export const submissionForm = z.object({
  candidateId: uuid,
  note: z.string().max(2000, "La nota no puede superar los 2000 caracteres."),
  consent: z.boolean().refine(Boolean, "Autoriza la revisión para continuar."),
})
export function workflowRequirements(input: {
  draft: AgentView["draft"]
  editor: DraftEditorStatus
  availableCollectionIds: string[]
  availableCodeIds: string[]
  codeReleaseId: string
  candidates: AgentView["candidates"]
  submittedCandidateIds: string[]
  candidateId: string
  consent: boolean
  note: string
  busy: boolean
}) {
  const { draft, editor } = input
  const savedValid =
    editableDraftContent.safeParse(draft.content).success &&
    requestedAccess.safeParse(draft.requestedAccess).success
  const draftRequirements: Requirement[] = [
    {
      label: "Borrador válido: instrucciones y habilidades completas",
      met: savedValid && editor.valid,
    },
    {
      label: "Todos los cambios guardados y diálogos cerrados",
      met: draft.revision > 0 && !editor.dirty && !editor.editingSkill,
    },
    {
      label: "Acceso vigente a las colecciones seleccionadas",
      met: draft.requestedAccess.collectionIds.every((id) =>
        input.availableCollectionIds.includes(id)
      ),
    },
  ]
  const alreadyFrozen = input.candidates.some(
    (c) =>
      c.revision === draft.revision && c.codeReleaseId === input.codeReleaseId
  )
  const freeze = [
    ...draftRequirements,
    {
      label: "Pruebas habilitadas por Agentonic para este agente",
      met: input.availableCodeIds.includes(input.codeReleaseId),
    },
    {
      label: "Esta revisión aún no tiene una versión preparada disponible",
      met: !alreadyFrozen,
    },
  ]
  const candidate = input.candidates.find((c) => c.id === input.candidateId)
  const submit = [
    ...draftRequirements,
    {
      label:
        "Versión congelada de la revisión guardada, disponible y sin enviar",
      met:
        !!candidate &&
        candidate.canSubmit &&
        candidate.revision === draft.revision &&
        !input.submittedCandidateIds.includes(candidate.id),
    },
    {
      label: "Nota válida (opcional, hasta 2000 caracteres)",
      met: input.note.length <= 2000,
    },
    { label: "Autorización de revisión aceptada", met: input.consent },
  ]
  const busy = input.busy || editor.pending
  return {
    alreadyFrozen,
    freeze,
    submit,
    canFreeze: !busy && freeze.every((r) => r.met),
    canSubmit: !busy && submit.every((r) => r.met),
  }
}
