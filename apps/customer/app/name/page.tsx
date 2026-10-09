import { redirect } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { nameRequired } from "@agentonic/contracts/identity"
import { AuthCard } from "@workspace/ui/components/auth-card"
import { ChooseNameForm } from "@workspace/ui/components/account-forms"
import { saveDisplayName } from "../actions"
// The panel sends anyone still on the "Miembro" placeholder here, typically
// people who joined before names were asked on accepting an invitation (N7).
export default async function NamePage() {
  const identity = await requireIdentity("customer")
  if (!nameRequired(identity.user)) redirect("/")
  return (
    <AuthCard
      title="Elige tu nombre"
      description="Así te verán las demás personas de tu espacio de trabajo."
    >
      <ChooseNameForm save={saveDisplayName} />
    </AuthCard>
  )
}
