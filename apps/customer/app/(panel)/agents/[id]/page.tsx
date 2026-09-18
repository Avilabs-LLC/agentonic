import { loadGmail } from "@agentonic/server/gmail"
import { loadLifecycle } from "@agentonic/server/lifecycle"
import { AgentLifecycle } from "@workspace/ui/components/agent-lifecycle"
import { loadReviewFlow } from "@agentonic/server/review-flow"
import { loadEvaluations } from "@agentonic/server/evaluation"
import { EvaluationPanel } from "@workspace/ui/components/evaluation-panel"
import { notFound } from "next/navigation"
import { loadWorkspace, loadAgent } from "@agentonic/server/authoring"
import { RecordHeader, BackRow } from "@workspace/ui/components/record-header"
import { AgentWorkflow } from "@workspace/ui/components/agent-workflow"
import { AgentPageTabs } from "@workspace/ui/components/agent-page-tabs"
import { AgentProposals } from "@workspace/ui/components/agent-proposals"
import { customerWorkspace } from "@/lib/workspace"
import {
  saveDraft,
  prepareVersion,
  openPreview,
  sendSubmission,
  withdrawSubmission,
  evaluationAction,
  reviewFlowAction,
  lifecycleAction,
} from "../actions"
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ workspace?: string }>
}) {
  const { selected } = await customerWorkspace(searchParams)
  const { id } = await params
  const [lifecycle, data, workspace, evaluations, reviewFlow, gmail] =
    await Promise.all([
      loadLifecycle("customer", selected.id, id),
      loadAgent(selected.id, id),
      loadWorkspace(selected.id),
      loadEvaluations("customer", selected.id, id),
      loadReviewFlow("customer", selected.id, id),
      loadGmail(selected.id, id),
    ])
  if (!data || !workspace || !lifecycle) notFound()
  if (!evaluations || !reviewFlow)
    throw new Error("No se pudieron cargar las evaluaciones.")
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <BackRow href={`/agents?workspace=${selected.id}`} />
      <RecordHeader
        title={data.agent.name}
        description={
          data.agent.description ??
          "Personaliza tu agente y prepara una propuesta."
        }
        actions={
          <span className="text-sm text-muted-foreground">
            {lifecycle.deployments.some((d) => d.online)
              ? "Activo en pruebas"
              : lifecycle.deployments.some((d) => d.status === "running")
                ? "Sin conexión"
                : "Sin despliegue activo"}
          </span>
        }
      />
      <AgentPageTabs
        activation={
          <AgentLifecycle
            state={lifecycle}
            workspaceId={selected.id}
            action={lifecycleAction.bind(null, selected.id)}
          />
        }
        configuration={
          <AgentWorkflow
            gmail={gmail} workspaceId={selected.id}
            key={data.draft.revision}
            data={data}
            collections={workspace.collections}
            save={saveDraft.bind(null, selected.id, id)}
            prepare={prepareVersion.bind(null, selected.id, id)}
            preview={openPreview.bind(null, selected.id, id)}
            submit={sendSubmission.bind(null, selected.id, id)}
          />
        }
        proposals={
          <>
            <AgentProposals
              agentName={data.agent.name}
              candidates={data.candidates}
              submissions={data.submissions}
              state={reviewFlow}
              action={reviewFlowAction.bind(null, selected.id)}
              withdraw={withdrawSubmission.bind(null, selected.id, id)}
            />
            {evaluations.length > 0 && (
              <details>
                <summary className="cursor-pointer text-sm font-medium">
                  Evaluaciones anteriores
                </summary>
                <div className="mt-4">
                  <EvaluationPanel
                    records={evaluations}
                    customer
                    labels={Object.fromEntries(
                      data.submissions.map((submission) => {
                        const candidate = data.candidates.find(
                          (item) => item.id === submission.candidateId
                        )
                        return [
                          submission.id,
                          `Propuesta ${submission.number}${candidate?.number ? ` · Versión ${candidate.number}` : ""}`,
                        ]
                      })
                    )}
                    action={evaluationAction.bind(null, selected.id)}
                  />
                </div>
              </details>
            )}
          </>
        }
      />
    </div>
  )
}
