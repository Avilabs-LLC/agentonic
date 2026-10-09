import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadOperationsAgent } from "@agentonic/server/operations"
import { loadReviewQueue } from "@agentonic/server/authoring"
import { formatUtcParts } from "@agentonic/contracts/format"
import { uuid } from "@agentonic/contracts/identity"
import { BackRow, RecordHeader } from "@workspace/ui/components/record-header"
import { OperationsAgentOverview } from "@workspace/ui/components/operations-agent"
import { WorkspaceName } from "@workspace/ui/components/workspace-name"
import { beginReview } from "../../submissions/actions"
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const { id } = await params
  if (!uuid.safeParse(id).success) notFound()
  const result = await loadOperationsAgent(id)
  if (!result) throw new Error("No se pudo cargar el agente.")
  const { agent } = result
  if (!agent) notFound()
  // Revisiones' own check of which open reviews may be opened now; when it
  // cannot be read, none open from here.
  const queue = agent.proposals.some((p) =>
    ["submitted", "in_review"].includes(p.status)
  )
    ? await loadReviewQueue(agent.workspaceId)
    : null
  const openable = (queue ?? [])
    .filter((row) => row.canOpen)
    .map((row) => row.id)
  return (
    <>
      <div className="space-y-3">
        <BackRow href="/agents" />
        <RecordHeader
          title={agent.name}
          description={
            <span className="flex flex-wrap items-center gap-x-1.5">
              <WorkspaceName name={agent.workspaceName} />
              <span>
                · Responsable: {agent.ownerName} · Creado el{" "}
                {formatUtcParts(agent.createdAt).date}
              </span>
            </span>
          }
        />
      </div>
      <OperationsAgentOverview
        agent={agent}
        now={new Date().toISOString()}
        openReview={beginReview}
        openable={openable}
      />
    </>
  )
}
