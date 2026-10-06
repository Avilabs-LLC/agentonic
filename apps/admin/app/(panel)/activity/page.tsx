import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadOperationsActivity } from "@agentonic/server/operations"
import { PageHeader } from "@workspace/ui/components/page-header"
import {
  OperationsActivityStats,
  OperationsActivityTable,
} from "@workspace/ui/components/operations"
import { operations } from "@/lib/navigation"
export default async function Page() {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const activity = await loadOperationsActivity()
  if (!activity) throw new Error("No se pudo cargar la actividad.")
  return (
    <>
      <PageHeader
        title={operations.activity.title}
        description="Los últimos 200 cambios registrados en todos los espacios de trabajo y el estado de los turnos. Las consultas se cuentan, no se listan."
      />
      <OperationsActivityStats
        runs={activity.runs}
        awaitingApproval={activity.awaitingApproval}
        reads24h={activity.reads24h}
      />
      <OperationsActivityTable events={activity.events} />
    </>
  )
}
