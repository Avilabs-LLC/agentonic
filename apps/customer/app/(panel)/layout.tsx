import { redirect } from "next/navigation"
import { environmentLabel } from "@agentonic/server/env"
import { requireIdentity } from "@agentonic/server/auth"
import { nameRequired } from "@agentonic/contracts/identity"
import { AppShell } from "@workspace/ui/components/app-shell"
import { navigation } from "@/lib/navigation"
import { logout } from "../actions"
export default async function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  const identity = await requireIdentity("customer")
  // Anyone still on the placeholder chooses a name before using the app. This is
  // a prompt, not an authorization check: the name grants nothing.
  if (nameRequired(identity.user)) redirect("/name")
  return (
    <AppShell
      app="customer"
      navigation={navigation}
      email={identity.email}
      environment={environmentLabel()}
      signOut={logout}
    >
      {children}
    </AppShell>
  )
}
