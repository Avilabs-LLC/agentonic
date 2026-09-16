import { notFound } from "next/navigation"
import { loadAgent } from "@agentonic/server/authoring"
import { loadCandidatePreview } from "@agentonic/server/preview"
import { preparedVersionLabel } from "@agentonic/contracts/workflow"
import { RecordHeader, BackRow } from "@workspace/ui/components/record-header"
import { LockKeyholeIcon } from "lucide-react"
import { AgentPreview } from "@workspace/ui/components/agent-preview"
import { customerWorkspace } from "@/lib/workspace"
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{
    workspace?: string
    candidate?: string
    preview?: string
  }>
}) {
  const { selected } = await customerWorkspace(searchParams)
  const { id } = await params
  const data = await loadAgent(selected.id, id)
  if (!data) notFound()
  const query = await searchParams
  const candidate = query.candidate
    ? data.candidates.find((c) => c.id === query.candidate && c.canPreview)
    : data.candidates.find((c) => c.canPreview)
  if (query.candidate && !candidate) notFound()
  const initialState =
    candidate && query.preview
      ? await loadCandidatePreview(selected.id, id, candidate.id, query.preview)
      : null
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <BackRow href={`/agents/${id}?workspace=${selected.id}`} />
      <RecordHeader
        title={`Probar ${data.agent.name}`}
        description="Conversa con una versión congelada. Los cambios del borrador no afectan esta prueba."
        actions={
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <LockKeyholeIcon aria-hidden="true" className="size-4" />
            Prueba privada
          </span>
        }
      />
      <AgentPreview
        key={`${candidate?.id ?? "none"}:${initialState?.id ?? "none"}`}
        workspaceId={selected.id}
        agentId={id}
        initialCandidateId={candidate?.id}
        initialState={initialState}
        candidates={data.candidates
          .filter((c) => c.canPreview)
          .map((c) => ({
            id: c.id,
            version: preparedVersionLabel(c),
            hash: c.hash,
          }))}
      />
    </div>
  )
}
