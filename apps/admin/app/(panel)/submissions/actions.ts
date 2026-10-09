"use server"
import { runLifecycle } from "@agentonic/server/lifecycle"
import { runEvaluationCommand } from "@agentonic/server/evaluation"
import { loadReviewFlow } from "@agentonic/server/review-flow"
import { revalidatePath } from "next/cache"
import { runAuthoringCommand } from "@agentonic/server/authoring"
import { loadOperationsUser } from "@agentonic/server/operations"
import {
  reviewStateChange,
  reviewView,
  type FormResult,
} from "@agentonic/contracts/authoring"
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

// Cambiar estado from the Revisiones list: the same decision as the review
// page's form. Opening records the review access the decision requires, as
// "Ver revisión" does; the database rechecks that the client confirmed the
// criteria and the evaluation finished.
export async function changeReviewState(
  workspaceId: string,
  submissionId: string,
  decision: string,
  feedback: string
): Promise<FormResult> {
  const input = reviewStateChange.safeParse({ decision, feedback })
  if (!input.success)
    return { ok: false, message: "Revisa el nuevo estado y el comentario." }
  const opened = await runAuthoringCommand("admin", {
    workspaceId,
    operation: "review.open",
    payload: { submissionId },
  })
  const review = opened.ok ? reviewView.safeParse(opened.data) : null
  if (!review?.success)
    return {
      ok: false,
      message: "La propuesta o su autorización ya no están disponibles.",
    }
  const r = await runAuthoringCommand("admin", {
    workspaceId,
    operation: "review.decide",
    payload: {
      submissionId,
      grantId: review.data.grantId,
      ...input.data,
    },
  })
  if (!r.ok)
    return {
      ok: false,
      message:
        "No se pudo cambiar el estado. El cliente debe confirmar los criterios y la evaluación debe terminar antes.",
    }
  revalidatePath("/submissions")
  return { ok: true, message: "Estado actualizado." }
}

// Ver usuario: the submitter's card, read on demand.
export async function loadMember(userId: string) {
  return loadOperationsUser(userId)
}
