import { requireVerifiedUser } from "@agentonic/server/auth"
import { AppShell } from "@workspace/ui/components/app-shell"
import { navigation } from "@/lib/navigation"
import { logout } from "../actions"
export default async function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  const identity = await requireVerifiedUser("customer")
  return (
    <AppShell
      app="customer"
      navigation={navigation}
      email={identity.email}
      signOut={logout}
    >
      {children}
    </AppShell>
  )
}
