import Link from "next/link"
import { redirect } from "next/navigation"
import { requireIdentity, signedInEmail } from "@agentonic/server/auth"
import { PLACEHOLDER_NAME } from "@agentonic/contracts/identity"
import { AuthCard } from "@workspace/ui/components/auth-card"
import { InvitationAcceptance } from "@workspace/ui/components/account-forms"
import { acceptTeam } from "../actions"
// A team invitation link lands here after /auth/confirm has signed the invitee in.
export default async function InvitationPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token = "" } = await searchParams
  const valid = /^[a-f0-9]{64}$/.test(token)
  const email = await signedInEmail("admin")
  if (valid && !email)
    redirect(`/login?next=${encodeURIComponent(`/invitation?token=${token}`)}`)
  // Someone who already chose a name keeps it unless they change it here.
  const current = email ? (await requireIdentity("admin")).user : null
  const name =
    current && current.displayName !== PLACEHOLDER_NAME
      ? current.displayName
      : ""
  return (
    <AuthCard
      title="Invitación al equipo de Agentonic"
      description="Te invitaron a Administración de Agentonic."
      footer={
        <Link href="/" className="text-xs text-muted-foreground underline">
          Ir a Administración
        </Link>
      }
    >
      {valid && email ? (
        <InvitationAcceptance
          email={email}
          name={name}
          joinedText="Ya formas parte del equipo de Agentonic."
          homeLabel="Ir a Administración"
          accept={acceptTeam.bind(null, token)}
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
