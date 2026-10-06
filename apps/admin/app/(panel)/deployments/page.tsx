import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadOperationsDeployments } from "@agentonic/server/operations"
import { PageHeader } from "@workspace/ui/components/page-header"
import {
  OperationsDeploymentsTable,
  OperationsInstallationsCard,
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
        description="Qué ejecuta cada servidor y cada despliegue de pruebas, con su uso autorizado y su gasto."
        count={overview.deployments.length}
      />
      <OperationsInstallationsCard
        hosts={overview.hosts}
        evaluators={overview.evaluators}
      />
      <OperationsDeploymentsTable deployments={overview.deployments} />
    </>
  )
}
