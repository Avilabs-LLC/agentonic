"use client"
import { useId, useState } from "react"
import { useRouter } from "next/navigation"
import { PlusIcon } from "lucide-react"
import type { FormResult } from "@agentonic/contracts/authoring"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import { Button } from "@workspace/ui/components/button"
import { ResourceCreateForm } from "@workspace/ui/components/resource-create-form"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@workspace/ui/components/select"
export function AgentCreateDialog({
  workspaceId,
  workspaceName,
  available,
  action,
  initiallyOpen = false,
  workspaces,
}: {
  workspaceId: string
  workspaceName: string
  available: boolean
  action: (data: FormData) => Promise<FormResult>
  initiallyOpen?: boolean
  workspaces?: {
    id: string
    name: string
    available: boolean
    action: (data: FormData) => Promise<FormResult>
  }[]
}) {
  const router = useRouter()
  const fieldId = useId()
  const [selectedId, setSelectedId] = useState(workspaceId)
  const selected = workspaces?.find((workspace) => workspace.id === selectedId)
  const selectedName = selected?.name ?? workspaceName
  const selectedAvailable = selected?.available ?? available
  const selectedAction = selected?.action ?? action
  const [open, setOpen] = useState(initiallyOpen)
  const [pending, setPending] = useState(false)
  function changeOpen(value: boolean) {
    if (pending) return
    setOpen(value)
    if (!value && initiallyOpen) {
      const query = new URLSearchParams(window.location.search)
      query.delete("create")
      router.replace(query.size ? `/agents?${query}` : "/agents", {
        scroll: false,
      })
    }
  }
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger render={<Button />}>
        <PlusIcon aria-hidden="true" />
        Crear agente
      </DialogTrigger>
      <DialogContent showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Crear agente</DialogTitle>
          <DialogDescription>
            Un nuevo borrador en {selectedName}. Serás su propietario y después
            podrás personalizar sus instrucciones y conocimiento.
          </DialogDescription>
        </DialogHeader>
        {workspaces && workspaces.length > 1 && (
          <Field>
            <FieldLabel htmlFor={fieldId}>Espacio de trabajo</FieldLabel>
            <Select
              items={workspaces.map((workspace) => ({
                value: workspace.id,
                label: workspace.name,
              }))}
              value={selectedId}
              onValueChange={(value) => {
                if (value) setSelectedId(value)
              }}
              disabled={pending}
            >
              <SelectTrigger id={fieldId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {workspaces.map((workspace) => (
                  <SelectItem key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {selectedAvailable ? (
          <ResourceCreateForm
            kind="agent"
            action={selectedAction}
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
