import { notFound } from "next/navigation"
import { loadAgent } from "@agentonic/server/authoring"
import { RecordHeader, BackRow } from "@workspace/ui/components/record-header"
import { Badge } from "@workspace/ui/components/badge"
import { AgentPreview } from "@workspace/ui/components/agent-preview"
import { customerWorkspace } from "@/lib/workspace"
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ workspace?: string }>
}) {
  const { selected } = await customerWorkspace(searchParams)
  const { id } = await params
  const data = await loadAgent(selected.id, id)
  if (!data) notFound()
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <BackRow href={`/agents/${id}?workspace=${selected.id}`} />
      <RecordHeader
        title={`Probar ${data.agent.name}`}
        description="Conversa con una versión congelada. Los cambios del borrador no afectan esta prueba."
        actions={<Badge variant="violet">Prueba privada</Badge>}
      />
      <AgentPreview
        workspaceId={selected.id}
        agentId={id}
        candidates={data.candidates
          .filter((c) => c.canPreview)
          .map((c) => ({ id: c.id, version: c.version, hash: c.hash }))}
      />
    </div>
  )
}
