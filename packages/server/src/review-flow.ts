import "server-only"
import { randomUUID } from "node:crypto"
import { withIdentity } from "@agentonic/database/client"
import {
  reviewFlowCommand,
  reviewFlowState,
} from "@agentonic/contracts/review-flow"
import { uuid, type AppKind } from "@agentonic/contracts/identity"
import type { FormResult } from "@agentonic/contracts/authoring"
import { requireVerifiedUser } from "./auth"
export async function runReviewFlow(
  workspaceId: string,
  input: unknown
): Promise<FormResult> {
  const parsed = reviewFlowCommand.safeParse(input)
  if (!uuid.safeParse(workspaceId).success || !parsed.success)
    return { ok: false, message: "Revisa los datos de la revisión." }
  const user = await requireVerifiedUser("customer")
  try {
    const result = await withIdentity(user.authId, workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<
        { result: { ok: boolean; code?: string } }[]
      >`SELECT agentonic.review_flow_command(${parsed.data.operation},${JSON.stringify(parsed.data.payload)}::jsonb,${randomUUID()}::uuid) result`
      return rows[0]?.result
    })
    if (!result?.ok)
      return {
        ok: false,
        message:
          result?.code === "conflict"
            ? "Los criterios cambiaron. Actualiza la página antes de continuar."
            : "Revisa cada situación: apruébala o indica por qué no aplica antes de evaluar.",
      }
    return {
      ok: true,
      message: {
        prepare:
          "Prepararemos los criterios con IA dentro del límite autorizado.",
        save: "Criterios y comentarios guardados.",
        confirm:
          "Criterios confirmados. La evaluación comenzará automáticamente.",
        cancel: "Revisión cancelada. Se conservará el consumo realizado.",
      }[parsed.data.operation],
    }
  } catch {
    return {
      ok: false,
      message:
        "No se pudo completar la acción. Revisa el estado de la propuesta y tus permisos.",
    }
  }
}
export async function loadReviewFlow(
  app: AppKind,
  workspaceId: string,
  targetId: string,
  grantId?: string
) {
  if (
    ![workspaceId, targetId, ...(grantId ? [grantId] : [])].every(
      (v) => uuid.safeParse(v).success
    )
  )
    return null
  const user = await requireVerifiedUser(app)
  try {
    return await withIdentity(user.authId, workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<
        { result: unknown }[]
      >`SELECT agentonic.review_flow_state(${targetId}::uuid,${grantId ?? null}::uuid) result`
      return reviewFlowState.parse(rows[0]?.result)
    })
  } catch {
    return null
  }
}
