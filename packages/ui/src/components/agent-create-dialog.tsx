"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { PlusIcon } from "lucide-react"
import type { FormResult } from "@agentonic/contracts/authoring"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import { Button } from "@workspace/ui/components/button"
import { ResourceCreateForm } from "@workspace/ui/components/resource-create-form"
export function AgentCreateDialog({
  workspaceId,
  workspaceName,
  available,
  action,
  initiallyOpen = false,
}: {
  workspaceId: string
  workspaceName: string
  available: boolean
  action: (data: FormData) => Promise<FormResult>
  initiallyOpen?: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(initiallyOpen)
  const [pending, setPending] = useState(false)
  function changeOpen(value: boolean) {
    if (pending) return
    setOpen(value)
    if (!value && initiallyOpen)
      router.replace(`/agents?workspace=${workspaceId}`, { scroll: false })
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button />}>
        <PlusIcon aria-hidden="true" />
        Crear agente
      </DialogTrigger>
      <DialogContent showCloseButton={!pending}>
        <DialogTitle>Crear agente</DialogTitle>
        <DialogDescription>
          Un nuevo borrador en {workspaceName}. Serás su propietario y después
          podrás personalizar sus instrucciones y conocimiento.
        </DialogDescription>
        {available ? (
          <ResourceCreateForm
            kind="agent"
            action={action}
            onPendingChange={setPending}
            onCancel={() => changeOpen(false)}
            onSuccess={() => setOpen(false)}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            La creación de agentes todavía no está habilitada para este espacio.
            El equipo de Agentonic debe habilitarla antes de continuar.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
