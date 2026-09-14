"use client"
import { useState, type ReactNode, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import type { FormResult } from "@agentonic/contracts/authoring"
import { Button } from "@workspace/ui/components/button"
import { notify } from "@workspace/ui/lib/toast"
export function MutationForm({
  action,
  children,
  label = "Guardar",
  disabled = false,
  destructive = false,
  alignActionBottom = false,
}: {
  action: (data: FormData) => Promise<FormResult>
  children: ReactNode
  label?: string
  disabled?: boolean
  destructive?: boolean
  alignActionBottom?: boolean
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const [message, setMessage] = useState("")
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    const data = new FormData(event.currentTarget)
    setPending(true)
    setMessage("")
    try {
      const result = await action(data)
      if (!result.ok) {
        setMessage(result.message)
        notify.destructive(result.message)
        return
      }
      notify.success(result.message)
      if (result.href) router.push(result.href)
      router.refresh()
    } catch {
      setMessage(
        "No se pudo completar la acción. Tus cambios siguen en el formulario."
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <form
      onSubmit={submit}
      className={alignActionBottom ? "flex flex-1 flex-col gap-4" : "space-y-4"}
    >
      <fieldset
        disabled={pending || disabled}
        className={alignActionBottom ? "flex-1 space-y-4" : "space-y-4"}
      >
        {children}
      </fieldset>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <Button
        className={alignActionBottom ? "self-start" : undefined}
        type="submit"
        variant={destructive ? "destructive" : "default"}
        disabled={pending || disabled}
      >
        {pending ? "Guardando…" : label}
      </Button>
    </form>
  )
}
