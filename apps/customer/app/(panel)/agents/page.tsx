import { notFound } from "next/navigation"
import {
  loadWorkspace,
  loadCustomerAgentListing,
} from "@agentonic/server/authoring"
import { PageHeader } from "@workspace/ui/components/page-header"
import { AuthoringTable } from "@workspace/ui/components/authoring-table"
import { AgentCreateDialog } from "@workspace/ui/components/agent-create-dialog"
import { createAgent } from "./actions"
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string | string[]; create?: string }>
}) {
  const { create, workspace } = await searchParams
  const listing = await loadCustomerAgentListing(workspace)
  if (!listing) notFound()
  const { agents, workspaces, selectedWorkspaces, selectedWorkspaceIds } =
    listing
  const creationWorkspaces = (
    await Promise.all(
      selectedWorkspaces.map(async (item) => {
        const data = await loadWorkspace(item.id)
        if (!data)
          throw new Error("No se pudieron cargar los espacios de trabajo.")
        return data.canCreate
          ? {
              id: item.id,
              name: item.name,
              available: data.creationAvailable,
              action: createAgent.bind(null, item.id),
            }
          : null
      })
    )
  ).filter((item) => item !== null)
  const defaultWorkspace = creationWorkspaces[0]
  return (
    <>
      <PageHeader
        title="Agentes"
        description="Personaliza tus agentes y prepara las versiones que revisarás con nuestro equipo."
        count={agents.length}
        actions={
          defaultWorkspace && (
            <AgentCreateDialog
              key={selectedWorkspaceIds.join(",")}
              workspaceId={defaultWorkspace.id}
              workspaceName={defaultWorkspace.name}
              available={defaultWorkspace.available}
              action={defaultWorkspace.action}
              workspaces={creationWorkspaces}
              initiallyOpen={create === "1"}
            />
          )
        }
      />
      <AuthoringTable
        agents={agents}
        workspaces={workspaces}
        selectedWorkspaceIds={selectedWorkspaceIds}
      />
    </>
  )
}
