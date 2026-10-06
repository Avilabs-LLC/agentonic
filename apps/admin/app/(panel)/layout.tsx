import { environmentLabel } from "@agentonic/server/env"
import { requireVerifiedUser } from "@agentonic/server/auth"
import { AppShell } from "@workspace/ui/components/app-shell"
import { navigation } from "@/lib/navigation"
import { logout } from "../actions"
export default async function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  const identity = await requireVerifiedUser("admin")
  return (
    <AppShell
      app="admin"
      navigation={navigation}
      email={identity.email}
      environment={environmentLabel()}
      signOut={logout}
    >
      {children}
    </AppShell>
  )
}
