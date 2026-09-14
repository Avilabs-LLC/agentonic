import { notFound } from "next/navigation"
import { loadWorkspace, loadAgentListing } from "@agentonic/server/authoring"
import { PageHeader } from "@workspace/ui/components/page-header"
import { WorkspacePicker } from "@workspace/ui/components/workspace-picker"
import { AuthoringTable } from "@workspace/ui/components/authoring-table"
import { AgentCreateDialog } from "@workspace/ui/components/agent-create-dialog"
import { createAgent } from "./actions"
import { customerWorkspace } from "@/lib/workspace"
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; create?: string }>
}) {
  const { create } = await searchParams
  const { identity, selected } = await customerWorkspace(searchParams)
  const [data, agents] = await Promise.all([
    loadWorkspace(selected.id),
    loadAgentListing(selected.id),
  ])
  if (!data) notFound()
  return (
    <>
      <PageHeader
        title="Agentes"
        description="Personaliza tus agentes y prepara las versiones que revisarás con nuestro equipo."
        count={agents.length}
        actions={
          data.canCreate && (
            <AgentCreateDialog
              key={selected.id}
              workspaceId={selected.id}
              workspaceName={selected.name}
              templates={data.templates}
              action={createAgent.bind(null, selected.id)}
              initiallyOpen={create === "1"}
            />
          )
        }
      />
      <WorkspacePicker
        workspaces={identity.workspaces}
        selected={selected.id}
        base="/agents"
      />
      <AuthoringTable agents={agents} workspaceId={selected.id} />
    </>
  )
}
