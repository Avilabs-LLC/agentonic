import { redirect } from "next/navigation"
import { safeNext } from "@agentonic/contracts/identity"
import { requirePasswordSession } from "@agentonic/server/auth"
import { secondFactorPending } from "@agentonic/server/account"
import { AuthCard } from "@workspace/ui/components/auth-card"
import { MfaChallengeForm } from "@workspace/ui/components/account-forms"
import { verifyMfa } from "../actions"
// The second step of signing in, for staff who enrolled an authenticator.
export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  await requirePasswordSession("admin")
  const next = safeNext((await searchParams).next)
  if (!(await secondFactorPending())) redirect(next)
  return (
    <AuthCard
      title="Verificación en dos pasos"
      description="Escribe el código de 6 dígitos que muestra tu aplicación de verificación."
    >
      <MfaChallengeForm action={verifyMfa} next={next} />
    </AuthCard>
  )
}
