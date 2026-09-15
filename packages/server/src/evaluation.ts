import "server-only"
import { randomUUID } from "node:crypto"
import { withIdentity } from "@agentonic/database/client"
import {
  evaluationCommand,
  evaluationRecord,
} from "@agentonic/contracts/evaluation"
import type { FormResult } from "@agentonic/contracts/authoring"
import { uuid, type AppKind } from "@agentonic/contracts/identity"
import { requireVerifiedUser } from "./auth"
export async function runEvaluationCommand(
  app: AppKind,
  workspaceId: string,
  input: unknown
): Promise<FormResult> {
  const parsed = evaluationCommand.safeParse(input)
  if (
    !uuid.safeParse(workspaceId).success ||
    !parsed.success ||
    (app === "customer" &&
      !["authorize", "cancel"].includes(parsed.data.operation))
  )
    return { ok: false, message: "Revisa los datos de la evaluación." }
  const actor = await requireVerifiedUser(app)
  try {
    const result = await withIdentity(actor.authId, workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<
        { result: { ok: boolean; id: string } }[]
      >`SELECT agentonic.evaluation_command(${parsed.data.operation},${JSON.stringify(parsed.data.payload)}::jsonb,${randomUUID()}::uuid) result`
      return rows[0]?.result
    })
    if (!result?.ok) throw new Error("denied")
    const messages = {
      plan: "Evaluación propuesta. El cliente debe autorizarla antes de ejecutarla.",
      authorize: "Evaluación autorizada y puesta en cola.",
      cancel: "Autorización de evaluación cancelada.",
      approve:
        "Versión aprobada por un máximo de 24 horas. Aún no se ha desplegado.",
      revoke: "Aprobación revocada.",
    }
    return {
      ok: true,
      message: messages[parsed.data.operation],
      ...(parsed.data.operation === "approve" ||
      parsed.data.operation === "revoke"
        ? { href: "/submissions" }
        : {}),
    }
  } catch {
    return {
      ok: false,
      message:
        "No se pudo completar la acción. Revisa la autorización, la evidencia y el estado actual.",
    }
  }
}
export async function loadEvaluations(
  app: AppKind,
  workspaceId: string,
  agentId: string,
  grantId?: string
) {
  if (
    ![workspaceId, agentId, ...(grantId ? [grantId] : [])].every(
      (value) => uuid.safeParse(value).success
    )
  )
    return null
  const actor = await requireVerifiedUser(app)
  try {
    return await withIdentity(actor.authId, workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<
        { result: unknown }[]
      >`SELECT agentonic.evaluation_list(${agentId}::uuid,${grantId ?? null}::uuid) result`
      return evaluationRecord.array().parse(rows[0]?.result)
    })
  } catch {
    return null
  }
}
