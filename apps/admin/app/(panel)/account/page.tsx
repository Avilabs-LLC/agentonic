import { requireIdentity } from "@agentonic/server/auth"
import { BackRow, RecordHeader } from "@workspace/ui/components/record-header"
import { Card, CardContent } from "@workspace/ui/components/card"
import { Separator } from "@workspace/ui/components/separator"
import { Button } from "@workspace/ui/components/button"
import Link from "next/link"
import { account } from "@/lib/navigation"
import { authenticatorState } from "@agentonic/server/account"
import {
  AuthenticatorCard,
  DisplayNameEditor,
} from "@workspace/ui/components/account-forms"
import { saveDisplayName } from "../../actions"
export default async function Page() {
  const identity = await requireIdentity("admin")
  const authenticator = await authenticatorState()
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
                {identity.user ? (
                  <DisplayNameEditor
                    name={identity.user.displayName}
                    save={saveDisplayName}
                  />
                ) : (
                  "Pendiente de vinculación"
                )}
              </dd>
            </div>
            <Separator />
            <div className="flex flex-wrap justify-between gap-2">
              <dt className="text-muted-foreground">Acceso a este panel</dt>
              <dd>{identity.hasAccess ? "Activo" : "Pendiente"}</dd>
            </div>
            <Separator />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <dt className="text-muted-foreground">Contraseña</dt>
              <dd>
                <Button
                  render={<Link href="/password" />}
                  nativeButton={false}
                  variant="outline"
                  size="sm"
                >
                  Cambiar contraseña
                </Button>
              </dd>
            </div>
          </dl>
        </CardContent>
      </Card>
      <AuthenticatorCard enabled={authenticator.enabled} />
    </>
  )
}
