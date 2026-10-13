import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadOperationsDeployments } from "@agentonic/server/operations"
import { environmentLabels } from "@agentonic/contracts/lifecycle"
import { PageHeader } from "@workspace/ui/components/page-header"
import {
  OperationsDeploymentsTable,
  OperationsLocalServers,
  OperationsServerTiles,
} from "@workspace/ui/components/operations"
import { operations } from "@/lib/navigation"
export default async function Page() {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const overview = await loadOperationsDeployments()
  if (!overview) throw new Error("No se pudieron cargar los despliegues.")
  return (
    <>
      <PageHeader
        title={operations.deployments.title}
        description={`Qué ejecuta ${environmentLabels.azure_staging}, según su verificación dos veces al día, y cada despliegue de pruebas con su uso autorizado y su gasto.`}
        count={overview.deployments.length}
        actions={
          <OperationsLocalServers
            hosts={overview.hosts}
            evaluators={overview.evaluators}
          />
        }
      />
      <OperationsServerTiles
        hosts={overview.hosts}
        evaluators={overview.evaluators}
        environment="azure_staging"
      />
      <OperationsDeploymentsTable deployments={overview.deployments} />
    </>
  )
}
