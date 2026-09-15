"use client"
import { useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import type { FormResult } from "@agentonic/contracts/authoring"
import { Button } from "@workspace/ui/components/button"
import {
  AlertDialog,
  AlertDialogTrigger,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@workspace/ui/components/alert-dialog"
import { notify } from "@workspace/ui/lib/toast"
export function ConfirmMutation({
  action,
  label,
  description,
  icon,
}: {
  action: () => Promise<FormResult>
  label: string
  description: string
  icon?: ReactNode
}) {
  const [pending, setPending] = useState(false)
  const router = useRouter()
  async function run() {
    setPending(true)
    try {
      const r = await action()
      if (!r.ok) {
        notify.destructive(r.message)
        return
      }
      notify.success(r.message)
      router.refresh()
    } catch {
      notify.destructive("No se pudo completar la acción.")
    } finally {
      setPending(false)
    }
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={
          <Button
            type="button"
            variant={icon ? "ghost" : "outline"}
            size={icon ? "icon-sm" : "sm"}
            disabled={pending}
            aria-label={icon ? label : undefined}
            title={icon ? label : undefined}
          />
        }
      >
        {icon ?? (pending ? "Procesando…" : label)}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={run}>Confirmar</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
