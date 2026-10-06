"use client"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import {
  signInSchema,
  type SignInInput,
  type ActionResult,
} from "@agentonic/contracts/identity"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Field,
  FieldLabel,
  FieldError,
  FieldGroup,
} from "@workspace/ui/components/field"
import { notify } from "@workspace/ui/lib/toast"
export function LoginForm({
  action,
  next = "/",
}: {
  action: (input: SignInInput) => Promise<ActionResult>
  next?: string
}) {
  const router = useRouter()
  const {
    register,
    handleSubmit,
    formState: { errors, isValid, isSubmitting },
  } = useForm<SignInInput>({
    resolver: zodResolver(signInSchema),
    mode: "onChange",
    defaultValues: { email: "", password: "" },
  })
  async function submit(input: SignInInput) {
    try {
      const result = await action(input)
      if (!result.ok) {
        notify.destructive(result.message)
        return
      }
      notify.success("Sesión iniciada.")
      router.replace(next)
      router.refresh()
    } catch {
      notify.destructive("No se pudo iniciar sesión. Inténtalo de nuevo.")
    }
  }
  return (
    <form onSubmit={handleSubmit(submit)} noValidate>
      <FieldGroup>
        <Field data-invalid={Boolean(errors.email)}>
          <FieldLabel htmlFor="email">Correo electrónico</FieldLabel>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "email-error" : undefined}
            {...register("email")}
          />
          <FieldError id="email-error" errors={[errors.email]} />
        </Field>
        <Field data-invalid={Boolean(errors.password)}>
          <FieldLabel htmlFor="password">Contraseña</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            aria-invalid={Boolean(errors.password)}
            aria-describedby={errors.password ? "password-error" : undefined}
            {...register("password")}
          />
          <FieldError id="password-error" errors={[errors.password]} />
        </Field>
        <Button
          type="submit"
          size="lg"
          className="h-10 w-full text-sm"
          disabled={!isValid || isSubmitting}
        >
          {isSubmitting ? "Iniciando sesión…" : "Iniciar sesión"}
        </Button>
      </FieldGroup>
    </form>
  )
}
