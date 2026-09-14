"use server"
import { revalidatePath } from "next/cache"
import { runAccessCommand } from "@agentonic/server/access"
import { runAuthoringCommand, loadAgent } from "@agentonic/server/authoring"
import {
  systemPromptInput,
  editableDraftContent,
  requestedAccess,
  type FormResult,
} from "@agentonic/contracts/authoring"
const value = (data: FormData, key: string) => String(data.get(key) ?? "")
const failed: FormResult = {
  ok: false,
  message: "No se pudo guardar. Comprueba los campos y tus permisos.",
}
export async function createAgent(
  workspaceId: string,
  data: FormData
): Promise<FormResult> {
  const r = await runAccessCommand("customer", {
    workspaceId,
    operation: "agent.create",
    payload: {
      name: value(data, "name"),
      slug: value(data, "slug"),
      description: value(data, "description"),
      templateVersionId: value(data, "templateVersionId"),
    },
  })
  if (!r.ok || !r.id) return failed
  revalidatePath("/agents")
  return {
    ok: true,
    message: "Agente creado.",
    href: `/agents/${r.id}?workspace=${workspaceId}`,
  }
}
export async function saveDraft(
  workspaceId: string,
  agentId: string,
  data: FormData
): Promise<FormResult> {
  const prompt = systemPromptInput.safeParse(value(data, "systemPrompt"))
  if (!prompt.success)
    return { ok: false, message: prompt.error.issues[0]!.message }
  const names = data.getAll("skillName")
  const instructions = data.getAll("skillInstructions")
  const r = await runAuthoringCommand("customer", {
    workspaceId,
    operation: "draft.save",
    payload: {
      agentId,
      revision: Number(value(data, "revision")),
      content: {
        version: 1,
        systemPrompt: value(data, "systemPrompt"),
        skills: names.map((name, i) => ({
          name: String(name),
          instructions: String(instructions[i] ?? ""),
        })),
      },
      requestedAccess: {
        version: 1,
        collectionIds: data.getAll("collections").map(String),
        tools: [],
      },
    },
  })
  if (!r.ok)
    return "code" in r && r.code === "conflict"
      ? {
          ok: false,
          message:
            "Este borrador cambió en otra sesión. Copia tus cambios antes de recargar; no se ha sobrescrito nada.",
        }
      : failed
  revalidatePath(`/agents/${agentId}`)
  return { ok: true, message: "Borrador guardado." }
}
export async function freezeCandidate(
  workspaceId: string,
  agentId: string,
  data: FormData
): Promise<FormResult> {
  const agent = await loadAgent(workspaceId, agentId)
  if (!agent) return failed
  if (
    !editableDraftContent.safeParse(agent.draft.content).success ||
    !requestedAccess.safeParse(agent.draft.requestedAccess).success
  )
    return {
      ok: false,
      message:
        "Completa las instrucciones y corrige el borrador antes de congelarlo.",
    }
  if (
    agent.candidates.some(
      (candidate) =>
        candidate.revision === agent.draft.revision &&
        candidate.codeReleaseId === value(data, "codeReleaseId")
    )
  )
    return {
      ok: false,
      message:
        "Esta revisión ya está congelada. Selecciónala en el paso 2 o guarda nuevos cambios.",
    }
  const r = await runAuthoringCommand("customer", {
    workspaceId,
    operation: "candidate.freeze",
    payload: {
      agentId,
      revision: Number(value(data, "revision")),
      codeReleaseId: value(data, "codeReleaseId"),
    },
  })
  if (!r.ok)
    return {
      ok: false,
      message:
        "Guarda instrucciones válidas y comprueba que esta revisión siga vigente.",
    }
  revalidatePath(`/agents/${agentId}`)
  return {
    ok: true,
    message: "Versión congelada. Todavía no ha sido evaluada.",
  }
}
export async function sendSubmission(
  workspaceId: string,
  agentId: string,
  data: FormData
): Promise<FormResult> {
  const agent = await loadAgent(workspaceId, agentId)
  if (
    !agent ||
    !editableDraftContent.safeParse(agent.draft.content).success ||
    !requestedAccess.safeParse(agent.draft.requestedAccess).success
  )
    return failed
  const candidate = agent.candidates.find(
    (item) => item.id === value(data, "candidateId")
  )
  if (
    !candidate?.canSubmit ||
    candidate.revision !== agent.draft.revision ||
    Number(value(data, "revision")) !== agent.draft.revision ||
    agent.submissions.some((item) => item.candidateId === candidate.id)
  )
    return {
      ok: false,
      message:
        "Guarda y congela la revisión actual; la versión seleccionada no está disponible para enviar.",
    }
  const r = await runAuthoringCommand("customer", {
    workspaceId,
    operation: "submission.send",
    payload: {
      candidateId: value(data, "candidateId"),
      note: value(data, "note"),
      consent: data.get("consent") === "on",
    },
  })
  if (!r.ok)
    return {
      ok: false,
      message:
        "No se pudo enviar. Comprueba los permisos y que esta versión no se haya enviado antes.",
    }
  revalidatePath(`/agents/${agentId}`)
  return { ok: true, message: "Propuesta enviada para revisión." }
}
export async function withdrawSubmission(
  workspaceId: string,
  agentId: string,
  submissionId: string
): Promise<FormResult> {
  const r = await runAuthoringCommand("customer", {
    workspaceId,
    operation: "submission.withdraw",
    payload: { submissionId },
  })
  if (!r.ok) return failed
  revalidatePath(`/agents/${agentId}`)
  return {
    ok: true,
    message: "Propuesta retirada y acceso de revisión revocado.",
  }
}
export async function createCollection(
  workspaceId: string,
  data: FormData
): Promise<FormResult> {
  const r = await runAccessCommand("customer", {
    workspaceId,
    operation: "collection.create",
    payload: { name: value(data, "name"), slug: value(data, "slug") },
  })
  if (!r.ok)
    return {
      ok: false,
      message:
        "No se pudo crear la colección. Comprueba que el identificador no esté en uso y que conserves permiso para crear colecciones.",
    }
  revalidatePath("/knowledge")
  return { ok: true, message: "Colección creada." }
}
export async function removeDocument(
  workspaceId: string,
  objectId: string
): Promise<FormResult> {
  const r = await runAuthoringCommand("customer", {
    workspaceId,
    operation: "document.remove",
    payload: { objectId },
  })
  if (!r.ok) return failed
  revalidatePath("/knowledge")
  return { ok: true, message: "Documento retirado del acceso activo." }
}
