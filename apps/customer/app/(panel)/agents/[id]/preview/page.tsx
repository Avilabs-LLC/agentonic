import { LockKeyholeIcon } from "lucide-react"
import { notFound, redirect } from "next/navigation"
import { loadAgent } from "@agentonic/server/authoring"
import { loadCandidatePreview } from "@agentonic/server/preview"
import { preparedVersionLabel } from "@agentonic/contracts/workflow"
import { RecordHeader, BackRow } from "@workspace/ui/components/record-header"
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
  const latest = data.candidates[0]
  const candidate = latest?.canPreview ? latest : undefined
  if (query.candidate && query.candidate !== candidate?.id)
    redirect(`/agents/${id}/preview?workspace=${selected.id}`)
  const initialState =
    candidate && query.preview
      ? await loadCandidatePreview(selected.id, id, candidate.id, query.preview)
      : null
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <BackRow href={`/agents/${id}?workspace=${selected.id}`} />
      <RecordHeader
        title={`Probar ${data.agent.name}`}
        actions={
          <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <LockKeyholeIcon aria-hidden="true" className="size-4" />
            Prueba privada
          </span>
        }
        description={
          candidate
            ? `${preparedVersionLabel(candidate)} · 10 minutos · Hasta 10 mensajes`
            : "Prepara una versión para comenzar."
        }
      />
      <AgentPreview
        key={`${candidate?.id ?? "none"}:${initialState?.id ?? "none"}`}
        workspaceId={selected.id}
        agentId={id}
        candidateId={candidate?.id}
        openModels={candidate?.openModels ?? false}
        initialState={initialState}
      />
    </div>
  )
}
