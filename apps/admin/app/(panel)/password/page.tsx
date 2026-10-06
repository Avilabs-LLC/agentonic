import { requireVerifiedUser } from "@agentonic/server/auth"
import { BackRow, RecordHeader } from "@workspace/ui/components/record-header"
import { Card, CardContent } from "@workspace/ui/components/card"
import { PasswordForm } from "@workspace/ui/components/account-forms"
import { savePassword } from "../../actions"
export default async function Page() {
  await requireVerifiedUser("admin")
  return (
    <>
      <div className="space-y-3">
        <BackRow href="/account" />
        <RecordHeader
          title="Contraseña"
          description="Elige la contraseña con la que entras a Agentonic."
        />
      </div>
      <Card className="max-w-md">
        <CardContent className="pt-6">
          <PasswordForm action={savePassword} done="/account" />
        </CardContent>
      </Card>
    </>
  )
}
