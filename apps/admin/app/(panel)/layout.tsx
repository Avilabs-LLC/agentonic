import { requireIdentity } from "@agentonic/server/auth"
import { AppShell } from "@workspace/ui/components/app-shell"
import { navigation } from "@/lib/navigation"
import { logout } from "../actions"
export default async function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  const identity = await requireIdentity("admin")
  return (
    <AppShell
      app="admin"
      navigation={navigation}
      email={identity.email}
      signOut={logout}
    >
      {children}
    </AppShell>
  )
}
