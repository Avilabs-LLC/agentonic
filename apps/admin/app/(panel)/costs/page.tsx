import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadOperationsCosts } from "@agentonic/server/operations"
import { PageHeader } from "@workspace/ui/components/page-header"
import {
  OperationsCostsTable,
  OperationsProvidersCard,
  OperationsTopAgentsCard,
} from "@workspace/ui/components/operations"
import { operations } from "@/lib/navigation"
export default async function Page() {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const costs = await loadOperationsCosts()
  if (!costs) throw new Error("No se pudieron cargar los costos.")
  return (
    <>
      <PageHeader
        title={operations.costs.title}
        description="Estimaciones de Agentonic según precios de lista, no facturas de los proveedores. Los últimos 30 días, por día y espacio de trabajo en su zona horaria."
      />
      <OperationsProvidersCard providers={costs.providers} />
      <OperationsCostsTable days={costs.days} />
      <OperationsTopAgentsCard agents={costs.agents} />
    </>
  )
}
