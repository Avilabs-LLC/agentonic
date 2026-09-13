import { BotIcon } from "lucide-react"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@workspace/ui/components/card"
import { LoginForm } from "@workspace/ui/components/login-form"
import { login } from "../actions"
export default function LoginPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground">
            <BotIcon />
          </span>
          <CardTitle className="text-2xl">Agentonic · Mi espacio</CardTitle>
          <CardDescription>
            Inicia sesión para acceder a tus espacios.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LoginForm action={login} />
        </CardContent>
        <CardFooter>
          <p className="text-xs text-muted-foreground">
            Usa tu cuenta confirmada. Si aún no tienes acceso, contacta con tu
            administrador.
          </p>
        </CardFooter>
      </Card>
    </main>
  )
}
