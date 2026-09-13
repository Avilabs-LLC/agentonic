import { requireIdentity } from "@agentonic/server/auth"
import { BackRow, RecordHeader } from "@workspace/ui/components/record-header"
import { Card, CardContent } from "@workspace/ui/components/card"
import { Separator } from "@workspace/ui/components/separator"
import { account } from "@/lib/navigation"
export default async function Page() {
  const identity = await requireIdentity("admin")
  return (
    <>
      <div className="space-y-3">
        <BackRow href="/" />
        <RecordHeader title={account.title} description={account.description} />
      </div>
      <Card>
        <CardContent className="pt-6">
          <dl className="space-y-4">
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">Correo confirmado</dt>
              <dd className="break-all">{identity.email}</dd>
            </div>
            <Separator />
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">Nombre</dt>
              <dd>
                {identity.user?.displayName ?? "Pendiente de vinculación"}
              </dd>
            </div>
            <Separator />
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">Acceso a este panel</dt>
              <dd>{identity.hasAccess ? "Activo" : "Pendiente"}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>
    </>
  )
}
