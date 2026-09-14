"use server"
import { revalidatePath } from "next/cache"
import { knowledgeCommand } from "@agentonic/server/rag"
import type { FormResult } from "@agentonic/contracts/authoring"
export async function processDocument(
  workspaceId: string,
  objectId: string
): Promise<FormResult> {
  const result = await knowledgeCommand(workspaceId, {
    operation: "ingest",
    payload: { objectId },
  })
  if (!result)
    return {
      ok: false,
      message: "No se pudo poner el documento en cola. Comprueba tus permisos.",
    }
  revalidatePath("/knowledge")
  return { ok: true, message: "Documento en cola de procesamiento." }
}
