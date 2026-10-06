import Link from "next/link"
import { safeNext } from "@agentonic/contracts/identity"
import { AuthCard } from "@workspace/ui/components/auth-card"
import { LoginForm } from "@workspace/ui/components/login-form"
import { login } from "../actions"
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; enlace?: string }>
}) {
  const query = await searchParams
  return (
    <AuthCard
      title="Agentonic · Administración"
      description="Acceso para el equipo de Agentonic."
      footer={
        <div className="w-full space-y-2 text-xs text-muted-foreground">
          <p>
            <Link href="/forgot-password" className="underline">
              ¿Olvidaste tu contraseña?
            </Link>
          </p>
          <p>
            Usa tu cuenta confirmada. Si aún no tienes acceso, contacta con tu
            administrador.
          </p>
        </div>
      }
    >
      {query.enlace === "invalido" && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          El enlace no es válido o ya venció. Pide uno nuevo.
        </p>
      )}
      <LoginForm action={login} next={safeNext(query.next)} />
    </AuthCard>
  )
}
