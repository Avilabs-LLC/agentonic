"use client"
import { useState } from "react"
import { EllipsisIcon } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@workspace/ui/components/dropdown-menu"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@workspace/ui/components/alert-dialog"
import { notify } from "@workspace/ui/lib/toast"
import type { ActionResult } from "@agentonic/contracts/identity"
type RowAction = {
  label: string
  icon: React.ReactNode
  destructive?: boolean
  disabled?: boolean
  run: () => Promise<ActionResult>
  successMessage: string
  confirm?: { title: string; description: string; confirmLabel: string }
}
export function DataTableRowActions({ actions }: { actions: RowAction[] }) {
  const [pending, setPending] = useState<RowAction | null>(null)
  const [busy, setBusy] = useState(false)
  async function execute(action: RowAction) {
    setBusy(true)
    try {
      const result = await action.run()
      if (result.ok) {
        notify.success(action.successMessage)
        setPending(null)
      } else notify.destructive(result.message)
    } catch {
      notify.destructive("No se pudo completar la acción.")
    } finally {
      setBusy(false)
    }
  }
  const ordered = [
    ...actions.filter((a) => !a.destructive),
    ...actions.filter((a) => a.destructive),
  ]
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              aria-label="Acciones del registro"
              disabled={busy}
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        {/* The menu opens from a small icon button: size it to its labels so
            they stay on one line. */}
        <DropdownMenuContent
          align="end"
          className="w-auto min-w-40 whitespace-nowrap"
        >
          {ordered.map((action, index) => (
            <div key={action.label}>
              {action.destructive &&
                (index === 0 || !ordered[index - 1]?.destructive) && (
                  <DropdownMenuSeparator />
                )}
              <DropdownMenuItem
                variant={action.destructive ? "destructive" : "default"}
                disabled={action.disabled || busy}
                onClick={() =>
                  action.confirm ? setPending(action) : execute(action)
                }
              >
                {action.icon}
                {action.label}
              </DropdownMenuItem>
            </div>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setPending(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pending?.confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.confirm?.description}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              variant={pending?.destructive ? "destructive" : "default"}
              onClick={() => {
                if (pending) void execute(pending)
              }}
            >
              {busy ? "Procesando…" : pending?.confirm?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
