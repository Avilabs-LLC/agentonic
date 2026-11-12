import { redirect } from "next/navigation"
import { safeNext } from "@agentonic/contracts/identity"
import { requirePasswordSession } from "@agentonic/server/auth"
import { secondFactorStep } from "@agentonic/server/account"
import { AuthCard } from "@workspace/ui/components/auth-card"
import {
  MfaChallengeForm,
  MfaEnrolment,
} from "@workspace/ui/components/account-forms"
import { confirmMfa, startMfa, verifyMfa } from "../actions"
// The second step of signing in. Admin never opens on a password alone: staff
// without an authenticator enrol one here first (architecture §87).
export default async function MfaPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  await requirePasswordSession("admin")
  const next = safeNext((await searchParams).next)
  const step = await secondFactorStep()
  if (step === "verified") redirect(next)
  return step === "challenge" ? (
    <AuthCard
      title="Verificación en dos pasos"
      description="Escribe el código de 6 dígitos que muestra tu aplicación de verificación."
    >
      <MfaChallengeForm action={verifyMfa} next={next} />
    </AuthCard>
  ) : (
    <AuthCard
      title="Activa la verificación en dos pasos"
      description="Administración pide, además de la contraseña, un código de una aplicación como Google Authenticator, 1Password o Authy. Configúrala para continuar."
    >
      <MfaEnrolment start={startMfa} confirm={confirmMfa} next={next} />
    </AuthCard>
  )
}
