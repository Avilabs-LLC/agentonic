import Link from "next/link"
import { redirect } from "next/navigation"
import { requireIdentity, signedInEmail } from "@agentonic/server/auth"
import { PLACEHOLDER_NAME } from "@agentonic/contracts/identity"
import { AuthCard } from "@workspace/ui/components/auth-card"
import { InvitationAcceptance } from "@workspace/ui/components/account-forms"
import { acceptWorkspace } from "../actions"
// An invitation link lands here after /auth/confirm has signed the invitee in.
export default async function InvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; token?: string }>
}) {
  const { workspace = "", token = "" } = await searchParams
  const valid =
    /^[0-9a-f-]{36}$/.test(workspace) && /^[a-f0-9]{64}$/.test(token)
  const email = await signedInEmail("customer")
  if (valid && !email)
    redirect(
      `/login?next=${encodeURIComponent(`/invitation?workspace=${workspace}&token=${token}`)}`
    )
  // Someone who already chose a name keeps it unless they change it here.
  const current = email ? (await requireIdentity("customer")).user : null
  const name =
    current && current.displayName !== PLACEHOLDER_NAME
      ? current.displayName
      : ""
  return (
    <AuthCard
      title="Invitación a Agentonic"
      description="Te invitaron a un espacio de trabajo."
      footer={
        <Link href="/" className="text-xs text-muted-foreground underline">
          Ir a mis espacios
        </Link>
      }
    >
      {valid && email ? (
        <InvitationAcceptance
          email={email}
          name={name}
          accept={acceptWorkspace.bind(null, workspace, token)}
        />
      ) : (
        <p className="text-sm">
          Este enlace de invitación no es válido. Pide a quien te invitó que te
          envíe uno nuevo.
        </p>
      )}
    </AuthCard>
  )
}
