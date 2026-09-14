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
})
export type DraftFormValues = z.infer<typeof draftEditorForm>
export type DraftEditorStatus = {
  dirty: boolean
  valid: boolean
  pending: boolean
  editingSkill: boolean
}
export type Requirement = { label: string; met: boolean }
export const freezeForm = z.object({ codeReleaseId: uuid })
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
  const freeze = [
    ...draftRequirements,
    {
      label: "Versión base disponible y seleccionada",
      met: input.availableCodeIds.includes(input.codeReleaseId),
    },
    {
      label: "Esta revisión aún no se ha congelado con esa versión base",
      met: !input.candidates.some(
        (c) =>
          c.revision === draft.revision &&
          c.codeReleaseId === input.codeReleaseId
      ),
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
    freeze,
    submit,
    canFreeze: !busy && freeze.every((r) => r.met),
    canSubmit: !busy && submit.every((r) => r.met),
  }
}
