import { loadReviewFlow } from "@agentonic/server/review-flow"
import { ReviewFlowPanel } from "@workspace/ui/components/review-flow-panel"
import { notFound, redirect } from "next/navigation"
import { loadEvaluations } from "@agentonic/server/evaluation"
import { EvaluationPanel } from "@workspace/ui/components/evaluation-panel"
import { openReview, loadReviewQueue } from "@agentonic/server/authoring"
import { RecordHeader, BackRow } from "@workspace/ui/components/record-header"
import { SubmissionReviewLayout } from "@workspace/ui/components/submission-review-layout"
import { decideReview, evaluationAction } from "../actions"
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ workspace?: string; grant?: string }>
}) {
  const { id } = await params
  const q = await searchParams
  if (!q.workspace || !q.grant) notFound()
  const review = await openReview(q.workspace, id, q.grant)
  if (!review) {
    const queue = await loadReviewQueue(q.workspace)
    const closed = queue?.find((row) => row.id === id)
    if (
      !closed ||
      ![
        "approved",
        "revoked",
        "changes_requested",
        "rejected",
        "withdrawn",
      ].includes(closed.status)
    )
      notFound()
    if (closed.status === "approved")
      redirect(`/submissions/${id}/receipt?workspace=${q.workspace}`)
    return (
      <>
        <BackRow href="/submissions" />
        <RecordHeader
          title={
            closed.status === "approved"
              ? "Versión aprobada"
              : "Revisión cerrada"
          }
          description="Consulta el estado de esta propuesta en la tabla de revisiones. El acceso temporal al contenido privado terminó al cerrar la revisión."
        />
      </>
    )
  }
  const evaluations = await loadEvaluations("admin", q.workspace, id, q.grant)
  const reviewFlow = await loadReviewFlow("admin", q.workspace, id, q.grant)
  if (!evaluations || !reviewFlow)
    throw new Error("No se pudieron cargar las evaluaciones.")
  return (
    <SubmissionReviewLayout
      review={review}
      canDecide={reviewFlow.canDecide === true}
      backHref={`/submissions?workspace=${q.workspace}`}
      needsAttention={reviewFlow.preparations.some((p) =>
        ["needs_changes", "needs_attention", "error"].includes(p.status)
      )}
      testsPassed={
        reviewFlow.preparations.some((p) => p.status === "approved") ||
        evaluations.some((e) => e.status === "passed")
      }
      decideAction={decideReview.bind(null, q.workspace, id, q.grant)}
      evaluation={
        <ReviewFlowPanel
          state={reviewFlow}
          grantId={q.grant}
          approveAction={evaluationAction.bind(null, q.workspace)}
        />
      }
      history={
        evaluations.length > 0 ? (
          <details className="rounded-xl border bg-card p-6">
            <summary className="cursor-pointer text-sm font-medium">
              Evaluaciones anteriores
            </summary>
            <div className="mt-4">
              <EvaluationPanel
                records={evaluations}
                grantId={q.grant}
                action={evaluationAction.bind(null, q.workspace)}
              />
            </div>
          </details>
        ) : undefined
      }
    />
  )
}
