import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadOperationsAgents } from "@agentonic/server/operations"
import { PageHeader } from "@workspace/ui/components/page-header"
import { OperationsAgentsTable } from "@workspace/ui/components/operations"
import { operations } from "@/lib/navigation"
export default async function Page() {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const agents = await loadOperationsAgents()
  if (!agents) throw new Error("No se pudieron cargar los agentes.")
  return (
    <>
      <PageHeader
        title={operations.agents.title}
        description="Todos los agentes de los clientes: capacidades de su última versión, despliegue y turnos recientes. No incluye instrucciones, documentos ni conversaciones."
        count={agents.length}
      />
      <OperationsAgentsTable agents={agents} />
    </>
  )
}
