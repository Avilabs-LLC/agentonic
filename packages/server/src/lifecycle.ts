import "server-only"
import { randomUUID } from "node:crypto"
import { withIdentity } from "@agentonic/database/client"
import {
  lifecycleState,
  lifecycleCommand,
  chatCommand,
  lifecycleErrors,
} from "@agentonic/contracts/lifecycle"
import type { FormResult } from "@agentonic/contracts/authoring"
import { uuid, type AppKind } from "@agentonic/contracts/identity"
import { requireVerifiedUser } from "./auth"
export async function loadLifecycle(
  app: AppKind,
  workspaceId: string,
  targetId: string
) {
  if (!uuid.safeParse(workspaceId).success || !uuid.safeParse(targetId).success)
    return null
  const user = await requireVerifiedUser(app)
  return withIdentity(user.authId, workspaceId, async (tx) => {
    const rows = await tx.$queryRaw<
      { result: unknown }[]
    >`SELECT agentonic.lifecycle_state(${targetId}::uuid) result`
    return rows[0]?.result ? lifecycleState.parse(rows[0].result) : null
  })
}
export async function runLifecycle(
  app: AppKind,
  workspaceId: string,
  input: unknown
): Promise<FormResult> {
  const parsed = lifecycleCommand.safeParse(input)
  if (!uuid.safeParse(workspaceId).success || !parsed.success)
    return { ok: false, message: "Revisa los datos." }
  const user = await requireVerifiedUser(app)
  try {
    const result = await withIdentity(user.authId, workspaceId, async (tx) => {
      const { operation, payload } = parsed.data
      const rows =
        operation === "request" || operation === "renew"
          ? await tx.$queryRaw<
              { result: { ok: boolean; code?: string } }[]
            >`SELECT agentonic.approval_renewal(${operation},${JSON.stringify(payload)}::jsonb,${randomUUID()}::uuid) result`
          : await tx.$queryRaw<
              { result: { ok: boolean; code?: string } }[]
            >`SELECT agentonic.deployment_command(${operation},${JSON.stringify(payload)}::jsonb,${randomUUID()}::uuid) result`
      return rows[0]?.result
    })
    if (!result?.ok)
      return {
        ok: false,
        message:
          lifecycleErrors[result?.code ?? ""] ??
          "No se pudo completar la acción. Revisa el estado y tus permisos.",
      }
    return {
      ok: true,
      message: {
        request:
          "Renovación solicitada. El cliente debe autorizar una nueva evaluación.",
        renew:
          "Nueva revisión iniciada para la misma versión. Revisa los criterios cuando estén listos.",
        authorize:
          "Uso de pruebas autorizado. El equipo puede activar esta versión.",
        activate:
          "Activación en cola. El estado cambiará cuando se verifique el agente.",
        stop: "Agente detenido. El consumo registrado se conserva.",
        renewal: "Renovación guardada.",
        extend: "Autorización renovada por 30 días más.",
      }[parsed.data.operation],
    }
  } catch {
    return {
      ok: false,
      message:
        "No se pudo completar la acción. Actualiza la página y revisa tus permisos.",
    }
  }
}
export async function runStagingChat(
  workspaceId: string,
  input: unknown
): Promise<unknown> {
  const parsed = chatCommand.safeParse(input)
  if (!uuid.safeParse(workspaceId).success || !parsed.success)
    return { ok: false, code: "unavailable" }
  const user = await requireVerifiedUser("customer")
  try {
    return await withIdentity(user.authId, workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<
        { result: unknown }[]
      >`SELECT agentonic.staging_chat(${parsed.data.operation},${JSON.stringify(parsed.data.payload)}::jsonb) result`
      return rows[0]?.result ?? { ok: false, code: "unavailable" }
    })
  } catch {
    return { ok: false, code: "unavailable" }
  }
}
