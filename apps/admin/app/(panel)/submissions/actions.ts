"use server"
import { revalidatePath } from "next/cache"
import { runAuthoringCommand } from "@agentonic/server/authoring"
import { reviewView, type FormResult } from "@agentonic/contracts/authoring"
export async function beginReview(
  workspaceId: string,
  submissionId: string
): Promise<FormResult> {
  const r = await runAuthoringCommand("admin", {
    workspaceId,
    operation: "review.open",
    payload: { submissionId },
  })
  if (!r.ok)
    return {
      ok: false,
      message: "La propuesta o su autorización ya no están disponibles.",
    }
  const review = reviewView.safeParse(r.data)
  if (!review.success)
    return { ok: false, message: "No se pudo abrir la revisión." }
  return {
    ok: true,
    message: "Acceso de revisión registrado.",
    href: `/submissions/${submissionId}?workspace=${workspaceId}&grant=${review.data.grantId}`,
  }
}
export async function decideReview(
  workspaceId: string,
  submissionId: string,
  grantId: string,
  data: FormData
): Promise<FormResult> {
  const r = await runAuthoringCommand("admin", {
    workspaceId,
    operation: "review.decide",
    payload: {
      submissionId,
      grantId,
      decision: String(data.get("decision") ?? ""),
      feedback: String(data.get("feedback") ?? ""),
    },
  })
  if (!r.ok)
    return {
      ok: false,
      message:
        "No se pudo registrar la decisión. Comprueba que la autorización siga vigente.",
    }
  revalidatePath("/submissions")
  return {
    ok: true,
    message: "Comentario y decisión registrados.",
    href: `/submissions?workspace=${workspaceId}`,
  }
}
