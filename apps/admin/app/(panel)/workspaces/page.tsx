import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadOperationsWorkspaces } from "@agentonic/server/operations"
import { PageHeader } from "@workspace/ui/components/page-header"
import {
  OperationsStaffCard,
  OperationsWorkspacesTable,
} from "@workspace/ui/components/operations"
import { operations } from "@/lib/navigation"
export default async function Page() {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const overview = await loadOperationsWorkspaces()
  if (!overview)
    throw new Error("No se pudieron cargar los espacios de trabajo.")
  return (
    <>
      <PageHeader
        title={operations.workspaces.title}
        description="Espacios de trabajo de los clientes con sus miembros, agentes e invitaciones, y el equipo de Agentonic."
        count={overview.workspaces.length}
      />
      <OperationsWorkspacesTable workspaces={overview.workspaces} />
      <OperationsStaffCard staff={overview.staff} />
    </>
  )
}
