"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { CheckIcon, ShieldCheckIcon } from "lucide-react"
import {
  displayNameSchema,
  emailOnlySchema,
  mfaCodeSchema,
  newPasswordSchema,
  PLACEHOLDER_NAME,
  type ActionResult,
  type DisplayNameInput,
  type EmailOnlyInput,
  type MfaCodeInput,
  type NewPasswordInput,
} from "@agentonic/contracts/identity"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { notify } from "@workspace/ui/lib/toast"

// Account flows shared by both apps (architecture §54). Every submission ends in
// exactly one notification; server actions validate again.

export function ForgotPasswordForm({
  action,
}: {
  action: (input: EmailOnlyInput) => Promise<ActionResult>
}) {
  const [sent, setSent] = useState(false)
  const {
    register,
    handleSubmit,
    formState: { errors, isValid, isSubmitting },
  } = useForm<EmailOnlyInput>({
    resolver: zodResolver(emailOnlySchema),
    mode: "onChange",
    defaultValues: { email: "" },
  })
  async function submit(input: EmailOnlyInput) {
    try {
      const result = await action(input)
      if (!result.ok) {
        notify.destructive(result.message)
        return
      }
      setSent(true)
      notify.success("Revisa tu correo.")
    } catch {
      notify.destructive("No se pudo enviar el enlace. Inténtalo de nuevo.")
    }
  }
  if (sent)
    return (
      <p className="text-sm">
        Si el correo tiene una cuenta en Agentonic, te enviamos un enlace para
        elegir una contraseña nueva. Vence en una hora.
      </p>
    )
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
            {...register("email")}
          />
          <FieldError errors={[errors.email]} />
        </Field>
        <Button
          type="submit"
          size="lg"
          className="h-10 w-full text-sm"
          disabled={!isValid || isSubmitting}
        >
          {isSubmitting ? "Enviando…" : "Enviar enlace"}
        </Button>
      </FieldGroup>
    </form>
  )
}

export function PasswordForm({
  action,
  done = "/",
}: {
  action: (input: NewPasswordInput) => Promise<ActionResult>
  done?: string
}) {
  const router = useRouter()
  const {
    register,
    handleSubmit,
    formState: { errors, isValid, isSubmitting },
  } = useForm<NewPasswordInput>({
    resolver: zodResolver(newPasswordSchema),
    mode: "onChange",
    defaultValues: { password: "", confirmation: "" },
  })
  async function submit(input: NewPasswordInput) {
    try {
      const result = await action(input)
      if (!result.ok) {
        notify.destructive(result.message)
        return
      }
      notify.success("Contraseña guardada.")
      router.replace(done)
      router.refresh()
    } catch {
      notify.destructive(
        "No se pudo guardar la contraseña. Inténtalo de nuevo."
      )
    }
  }
  return (
    <form onSubmit={handleSubmit(submit)} noValidate>
      <FieldGroup>
        <Field data-invalid={Boolean(errors.password)}>
          <FieldLabel htmlFor="password">Contraseña nueva</FieldLabel>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={Boolean(errors.password)}
            {...register("password")}
          />
          <FieldDescription>Entre 10 y 72 caracteres.</FieldDescription>
          <FieldError errors={[errors.password]} />
        </Field>
        <Field data-invalid={Boolean(errors.confirmation)}>
          <FieldLabel htmlFor="confirmation">Repite la contraseña</FieldLabel>
          <Input
            id="confirmation"
            type="password"
            autoComplete="new-password"
            aria-invalid={Boolean(errors.confirmation)}
            {...register("confirmation")}
          />
          <FieldError errors={[errors.confirmation]} />
        </Field>
        <Button type="submit" disabled={!isValid || isSubmitting}>
          {isSubmitting ? "Guardando…" : "Guardar contraseña"}
        </Button>
      </FieldGroup>
    </form>
  )
}

function CodeForm({
  submitLabel,
  onCode,
}: {
  submitLabel: string
  onCode: (code: string) => Promise<void>
}) {
  const {
    register,
    handleSubmit,
    formState: { errors, isValid, isSubmitting },
  } = useForm<MfaCodeInput>({
    resolver: zodResolver(mfaCodeSchema),
    mode: "onChange",
    defaultValues: { code: "" },
  })
  return (
    <form onSubmit={handleSubmit(({ code }) => onCode(code))} noValidate>
      <FieldGroup>
        <Field data-invalid={Boolean(errors.code)}>
          <FieldLabel htmlFor="code">Código de 6 dígitos</FieldLabel>
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            className="tabular-nums"
            aria-invalid={Boolean(errors.code)}
            {...register("code")}
          />
          <FieldError errors={[errors.code]} />
        </Field>
        <Button type="submit" disabled={!isValid || isSubmitting}>
          {isSubmitting ? "Verificando…" : submitLabel}
        </Button>
      </FieldGroup>
    </form>
  )
}

export function MfaChallengeForm({
  action,
  next,
}: {
  action: (input: MfaCodeInput) => Promise<ActionResult>
  next: string
}) {
  const router = useRouter()
  return (
    <CodeForm
      submitLabel="Verificar"
      onCode={async (code) => {
        try {
          const result = await action({ code })
          if (!result.ok) {
            notify.destructive(result.message)
            return
          }
          notify.success("Sesión verificada.")
          router.replace(next)
          router.refresh()
        } catch {
          notify.destructive("No se pudo verificar. Inténtalo de nuevo.")
        }
      }}
    />
  )
}

type Enrolment = { factorId: string; qrCode: string; secret: string }
export function AuthenticatorCard({
  enabled,
  start,
  confirm,
  disable,
}: {
  enabled: boolean
  start: () => Promise<
    ({ ok: true } & Enrolment) | { ok: false; message: string }
  >
  confirm: (input: { factorId: string; code: string }) => Promise<ActionResult>
  disable: () => Promise<ActionResult>
}) {
  const router = useRouter()
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmOff, setConfirmOff] = useState(false)
  async function begin() {
    setBusy(true)
    try {
      const result = await start()
      if (!result.ok) {
        notify.destructive(result.message)
        return
      }
      setEnrolment(result)
    } catch {
      notify.destructive(
        "No se pudo iniciar la activación. Inténtalo de nuevo."
      )
    } finally {
      setBusy(false)
    }
  }
  async function turnOff() {
    setBusy(true)
    try {
      const result = await disable()
      if (!result.ok) {
        notify.destructive(result.message)
        return
      }
      notify.success("Verificación en dos pasos desactivada.")
      setConfirmOff(false)
      router.refresh()
    } catch {
      notify.destructive("No se pudo desactivar. Inténtalo de nuevo.")
    } finally {
      setBusy(false)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Verificación en dos pasos</CardTitle>
        <CardDescription>
          Además de la contraseña, cada inicio de sesión pide un código de una
          aplicación como Google Authenticator, 1Password o Authy. Es opcional.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {enabled ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="inline-flex items-center gap-2 text-sm">
              <ShieldCheckIcon aria-hidden="true" className="size-4" />
              Activada
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirmOff(true)}
            >
              Desactivar
            </Button>
          </div>
        ) : enrolment ? (
          <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
            {/* Supabase returns the QR code as an SVG data URI. */}
            <img
              src={enrolment.qrCode}
              alt="Código QR para tu aplicación de verificación"
              className="size-40 rounded-md bg-white p-2"
            />
            <div className="space-y-3">
              <p className="text-sm">
                Escanea el código con tu aplicación, o escribe esta clave:
              </p>
              <p className="font-mono text-sm break-all">{enrolment.secret}</p>
              <CodeForm
                submitLabel="Activar"
                onCode={async (code) => {
                  try {
                    const result = await confirm({
                      factorId: enrolment.factorId,
                      code,
                    })
                    if (!result.ok) {
                      notify.destructive(result.message)
                      return
                    }
                    notify.success("Verificación en dos pasos activada.")
                    setEnrolment(null)
                    router.refresh()
                  } catch {
                    notify.destructive(
                      "No se pudo activar. Inténtalo de nuevo."
                    )
                  }
                }}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">No activada</p>
            <Button type="button" disabled={busy} onClick={begin}>
              {busy ? "Preparando…" : "Activar"}
            </Button>
          </div>
        )}
      </CardContent>
      <AlertDialog open={confirmOff} onOpenChange={setConfirmOff}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Desactivar la verificación en dos pasos
            </AlertDialogTitle>
            <AlertDialogDescription>
              Tu cuenta de Administración volverá a abrirse solo con la
              contraseña. Puedes activarla de nuevo cuando quieras.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={turnOff}
            >
              {busy ? "Desactivando…" : "Desactivar"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

export function InvitationAcceptance({
  accept,
  email,
  name = "",
  joinedText = "Ya formas parte del espacio de trabajo.",
  homeLabel = "Ir a mis espacios",
}: {
  accept: (input: DisplayNameInput) => Promise<ActionResult>
  email: string
  /** The person's current name, when they already chose one. */
  name?: string
  /** What accepting made the person part of; Admin names the team. */
  joinedText?: string
  /** The button back to the app's home. */
  homeLabel?: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<DisplayNameInput>({
    resolver: zodResolver(displayNameSchema),
    mode: "onChange",
    defaultValues: { displayName: name },
  })
  async function submit(input: DisplayNameInput) {
    setBusy(true)
    try {
      const result = await accept(input)
      if (!result.ok) {
        notify.destructive(result.message)
        return
      }
      setAccepted(true)
      notify.success("Invitación aceptada.")
      router.refresh()
    } catch {
      notify.destructive(
        "No se pudo aceptar la invitación. Inténtalo de nuevo."
      )
    } finally {
      setBusy(false)
    }
  }
  if (accepted)
    return (
      <div className="space-y-4">
        <p className="inline-flex items-center gap-2 text-sm">
          <CheckIcon aria-hidden="true" className="size-4" />
          {joinedText}
        </p>
        <p className="text-sm text-muted-foreground">
          Si es tu primera vez en Agentonic, elige una contraseña para entrar la
          próxima vez.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => router.replace("/password")}>
            Elegir contraseña
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => router.replace("/")}
          >
            {homeLabel}
          </Button>
        </div>
      </div>
    )
  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="space-y-4">
      <p className="text-sm">
        Entraste como <span className="break-all">{email}</span>. La invitación
        solo vale para ese correo.
      </p>
      <Field data-invalid={Boolean(errors.displayName)}>
        <FieldLabel htmlFor="invitation-name">Tu nombre</FieldLabel>
        <Input
          id="invitation-name"
          autoComplete="name"
          maxLength={120}
          aria-invalid={Boolean(errors.displayName)}
          {...register("displayName")}
        />
        <FieldDescription>
          Así te verán las personas de tu espacio de trabajo.
        </FieldDescription>
        <FieldError errors={[errors.displayName]} />
      </Field>
      <Button type="submit" disabled={busy || !isValid}>
        {busy ? "Aceptando…" : "Aceptar invitación"}
      </Button>
    </form>
  )
}

/** The name prompt for anyone still on the placeholder; the panel waits for it. */
export function ChooseNameForm({
  save,
}: {
  save: (input: DisplayNameInput) => Promise<ActionResult>
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<DisplayNameInput>({
    resolver: zodResolver(displayNameSchema),
    mode: "onChange",
    defaultValues: { displayName: "" },
  })
  async function submit(input: DisplayNameInput) {
    setBusy(true)
    try {
      const result = await save(input)
      if (!result.ok) {
        notify.destructive(result.message)
        setBusy(false)
        return
      }
      notify.success("Nombre guardado.")
      router.replace("/")
    } catch {
      notify.destructive("No se pudo guardar tu nombre. Inténtalo de nuevo.")
      setBusy(false)
    }
  }
  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="space-y-4">
      <Field data-invalid={Boolean(errors.displayName)}>
        <FieldLabel htmlFor="choose-name">Tu nombre</FieldLabel>
        <Input
          id="choose-name"
          autoComplete="name"
          maxLength={120}
          autoFocus
          aria-invalid={Boolean(errors.displayName)}
          {...register("displayName")}
        />
        <FieldDescription>Puedes cambiarlo después en Mi cuenta.</FieldDescription>
        <FieldError errors={[errors.displayName]} />
      </Field>
      <Button type="submit" disabled={busy || !isValid}>
        {busy ? "Guardando…" : "Continuar"}
      </Button>
    </form>
  )
}

/** The Nombre row of Mi cuenta in both apps: shown, then edited in place (N7). */
export function DisplayNameEditor({
  name,
  save,
}: {
  name: string
  save: (input: DisplayNameInput) => Promise<ActionResult>
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isValid, isSubmitting },
  } = useForm<DisplayNameInput>({
    resolver: zodResolver(displayNameSchema),
    mode: "onChange",
    defaultValues: { displayName: name === PLACEHOLDER_NAME ? "" : name },
  })
  async function submit(input: DisplayNameInput) {
    try {
      const result = await save(input)
      if (!result.ok) {
        notify.destructive(result.message)
        return
      }
      notify.success("Nombre guardado.")
      setEditing(false)
      router.refresh()
    } catch {
      notify.destructive("No se pudo guardar tu nombre. Inténtalo de nuevo.")
    }
  }
  if (!editing)
    return (
      <span className="flex flex-wrap items-center gap-3">
        <span>{name}</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            reset({ displayName: name === PLACEHOLDER_NAME ? "" : name })
            setEditing(true)
          }}
        >
          {name === PLACEHOLDER_NAME ? "Añadir tu nombre" : "Cambiar nombre"}
        </Button>
      </span>
    )
  return (
    <form
      onSubmit={handleSubmit(submit)}
      noValidate
      // The row sizes to its content, so the editor sets its own width.
      className="flex w-80 max-w-full flex-col gap-2"
    >
      <Field data-invalid={Boolean(errors.displayName)}>
        <FieldLabel htmlFor="account-name" className="sr-only">
          Nombre
        </FieldLabel>
        <Input
          id="account-name"
          autoComplete="name"
          maxLength={120}
          autoFocus
          aria-invalid={Boolean(errors.displayName)}
          {...register("displayName")}
        />
        <FieldError errors={[errors.displayName]} />
      </Field>
      <span className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isSubmitting}
          onClick={() => setEditing(false)}
        >
          Cancelar
        </Button>
        <Button type="submit" size="sm" disabled={!isValid || isSubmitting}>
          {isSubmitting ? "Guardando…" : "Guardar"}
        </Button>
      </span>
    </form>
  )
}
