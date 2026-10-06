import Link from "next/link"
import { AuthCard } from "@workspace/ui/components/auth-card"
import { ForgotPasswordForm } from "@workspace/ui/components/account-forms"
import { requestReset } from "../actions"
export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Restablecer contraseña"
      description="Te enviaremos un enlace para elegir una contraseña nueva."
      footer={
        <Link href="/login" className="text-xs text-muted-foreground underline">
          Volver a iniciar sesión
        </Link>
      }
    >
      <ForgotPasswordForm action={requestReset} />
    </AuthCard>
  )
}
