import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadExpiryOverview } from "@agentonic/server/expiry"
import { PageHeader } from "@workspace/ui/components/page-header"
import {
  ExpiryTable,
  LocalRegistrations,
  RegistrationTiles,
} from "@workspace/ui/components/expiry-overview"
import { expirations } from "@/lib/navigation"
export default async function Page() {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const overview = await loadExpiryOverview()
  if (!overview) throw new Error("No se pudieron cargar los vencimientos.")
  return (
    <>
      <PageHeader
        title={expirations.title}
        description="Plazos de aprobación, uso autorizado por el cliente y verificación de servidores, que dura 30 días, con quién debe actuar en cada caso."
        count={overview.rows.length}
        actions={
          <LocalRegistrations
            registrations={overview.registrations}
            now={overview.now}
          />
        }
      />
      <RegistrationTiles
        registrations={overview.registrations}
        now={overview.now}
        environment="azure_staging"
      />
      <ExpiryTable rows={overview.rows} now={overview.now} />
    </>
  )
}
