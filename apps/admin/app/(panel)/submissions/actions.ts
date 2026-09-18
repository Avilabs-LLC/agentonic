"use server"
import { runLifecycle } from "@agentonic/server/lifecycle"
import { runEvaluationCommand } from "@agentonic/server/evaluation"
import { loadReviewFlow } from "@agentonic/server/review-flow"
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
  const flow = await loadReviewFlow("admin", workspaceId, submissionId, grantId)
  if (!flow?.canDecide)
    return {
      ok: false,
      message:
        "El cliente debe confirmar los criterios y la evaluación debe terminar antes de registrar una decisión.",
    }
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

export async function evaluationAction(workspaceId: string, input: unknown) {
  const result = await runEvaluationCommand("admin", workspaceId, input)
  if (result.ok) revalidatePath("/submissions", "layout")
  return result
}

export async function revokeApproval(
  workspaceId: string,
  submissionId: string,
  feedback: string
) {
  return evaluationAction(workspaceId, {
    operation: "revoke",
    payload: { submissionId, feedback },
  })
}

export async function lifecycleAction(workspaceId: string, input: unknown) {
  const result = await runLifecycle("admin", workspaceId, input)
  if (result.ok) revalidatePath("/submissions", "layout")
  return result
}
