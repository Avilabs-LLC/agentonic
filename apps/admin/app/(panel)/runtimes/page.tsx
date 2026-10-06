import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadOperationsReleases } from "@agentonic/server/operations"
import { PageHeader } from "@workspace/ui/components/page-header"
import { OperationsReleasesTable } from "@workspace/ui/components/operations"
import { operations } from "@/lib/navigation"
export default async function Page() {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const releases = await loadOperationsReleases()
  if (!releases)
    throw new Error("No se pudieron cargar las versiones del runtime.")
  return (
    <>
      <PageHeader
        title={operations.runtimes.title}
        description="Versiones publicadas del runtime, el commit del que salen, dónde están instaladas y cuántos espacios de trabajo pueden usarlas. Se publican e instalan desde el Mac."
        count={releases.length}
      />
      <OperationsReleasesTable releases={releases} />
    </>
  )
}
