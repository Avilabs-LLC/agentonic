import { requireIdentity } from "@agentonic/server/auth"
import { PageHeader } from "@workspace/ui/components/page-header"
import { AccessPending } from "@workspace/ui/components/access-pending"
import { FoundationRoadmap } from "@workspace/ui/components/foundation-roadmap"
import { home } from "@/lib/navigation"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
} from "@workspace/ui/components/card"
export default async function Page() {
  const identity = await requireIdentity("admin")
  return (
    <>
      <PageHeader title={home.title} description={home.description} />
      {identity.hasAccess ? (
        <>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Tu acceso</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="font-semibold">Personal de Agentonic</p>
                <p className="text-sm text-muted-foreground">
                  {identity.email}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Operación</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                <p className="font-semibold">Revisión de propuestas</p>
                <p className="text-sm text-muted-foreground">
                  Revisa configuraciones enviadas por clientes y devuelve
                  comentarios. Las evaluaciones y los despliegues aún no están
                  habilitados.
                </p>
              </CardContent>
            </Card>
          </div>
          <FoundationRoadmap customer={false} />
        </>
      ) : (
        <AccessPending admin={true} />
      )}
    </>
  )
}
