"use client"
import { useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import {
  AgentAssetList,
  type AgentAsset,
} from "@workspace/ui/components/agent-asset-list"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from "@workspace/ui/components/dialog"
import { notify } from "@workspace/ui/lib/toast"

const examples = {
  tools: {
    title: "Herramientas",
    description:
      "Define las acciones que tu agente podrá realizar cuando sean aprobadas.",
    name: "Buscar tarjetas en Trello",
    summary:
      "Consulta tarjetas de un tablero autorizado, sin modificar su contenido.",
    detail:
      "Aquí podrás revisar qué hace cada herramienta, sus parámetros y los permisos que solicita. Las acciones de escritura se autorizarán por separado.",
  },
  connections: {
    title: "Conexiones",
    description:
      "Elige las cuentas y fuentes externas que podrá utilizar tu agente.",
    name: "Google Drive · Cuenta de ejemplo",
    summary: "Una carpeta seleccionada como fuente de conocimiento.",
    detail:
      "Aquí podrás revisar la cuenta conectada y las carpetas seleccionadas. Importar conocimiento y permitir acciones en tu cuenta serán permisos independientes.",
  },
}

export function AgentCapabilityPlaceholder({
  kind,
}: {
  kind: keyof typeof examples
}) {
  const [visible, setVisible] = useState(true)
  const [open, setOpen] = useState(false)
  const example = examples[kind]
  const row: AgentAsset = {
    id: kind,
    name: example.name,
    description: example.summary,
    example: true,
  }
  return (
    <AgentSettingsCard
      title={example.title}
      description={example.description}
      action={<Badge variant="slate">Próximamente</Badge>}
      footer={
        <>
          <span>Vista de ejemplo. No forma parte del borrador.</span>
          {!visible && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setVisible(true)}
            >
              Mostrar ejemplo
            </Button>
          )}
        </>
      }
    >
      <AgentAssetList
        label={`${example.title} de ejemplo`}
        rows={visible ? [row] : []}
        empty="No hay ejemplos visibles."
        onView={() => setOpen(true)}
        onRemove={() => {
          setVisible(false)
          notify.success("Ejemplo ocultado. No se modificó el agente.")
        }}
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>{example.name}</DialogTitle>
          <DialogDescription>
            Ejemplo de interfaz · No está configurado ni conectado.
          </DialogDescription>
          <p className="text-sm leading-relaxed">{example.detail}</p>
          <div className="rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
            Esta vista no ejecuta acciones, no importa documentos y no solicita
            credenciales.
          </div>
          <div className="flex justify-end">
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cerrar
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </AgentSettingsCard>
  )
}
