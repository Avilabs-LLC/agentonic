"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  PlugIcon,
  WrenchIcon,
  MailIcon,
  CheckIcon,
  PlusIcon,
} from "lucide-react"
import {
  gmailLabels,
  gmailOperation,
  type GmailState,
} from "@agentonic/contracts/gmail"
import type { AgentView } from "@agentonic/contracts/authoring"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import { Button } from "@workspace/ui/components/button"
import { Checkbox } from "@base-ui/react/checkbox"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@workspace/ui/components/select"
import { notify } from "@workspace/ui/lib/toast"
export async function gmailCommand(
  workspace: string,
  operation: string,
  payload: Record<string, unknown>
) {
  const response = await fetch(`/api/gmail?workspace=${workspace}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, payload }),
    cache: "no-store",
  })
  const result = (await response.json()) as Record<string, unknown>
  if (!response.ok)
    throw new Error(String(result.error ?? "No se pudo completar la acción."))
  return result
}
export function GmailConnection({
  state,
  workspaceId,
  agentId,
  tools,
  onTools,
  disabled,
}: {
  state: GmailState
  workspaceId: string
  agentId: string
  tools: AgentView["draft"]["requestedAccess"]["tools"]
  onTools: (tools: AgentView["draft"]["requestedAccess"]["tools"]) => void
  disabled: boolean
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [connecting, setConnecting] = useState(false),
    [remove, setRemove] = useState<string | null>(null)
  const selected = tools[0]
  const [chosenAccount, setChosenAccount] = useState(
    selected?.connectionId ??
      state.connections.find((c) => c.status === "connected")?.id ??
      ""
  )
  const connection = state.connections.find(
    (c) => c.id === chosenAccount && c.status === "connected"
  )
  async function permission(
    op: (typeof gmailOperation.options)[number],
    checked: boolean
  ) {
    if (!connection) return
    const operations = checked
      ? [
          ...(selected?.connectionId === connection.id
            ? selected.operations
            : []),
          op,
        ]
      : (selected?.operations ?? []).filter((o) => o !== op)
    setBusy(true)
    try {
      await gmailCommand(workspaceId, "permissions", {
        agentId,
        connectionId: connection.id,
        operations,
      })
      onTools(
        operations.length ? [{ connectionId: connection.id, operations }] : []
      )
    } catch (e) {
      notify.destructive(
        e instanceof Error ? e.message : "No se pudo guardar el permiso."
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <AgentSettingsCard
        title="Conexiones"
        icon={<PlugIcon />}
        description="Conecta una cuenta y elige qué puede hacer este agente."
        footer="La cuenta es privada y solo tú puedes autorizar acciones. Conectarla no importa correos a Conocimiento. Puedes habilitar sus herramientas al iniciar Probar agente; después de la activación también se usan desde Chats."
      >
        <div className="space-y-4">
          {state.connections.length ? (
            state.connections.map((c) => (
              <div
                key={c.id}
                className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <MailIcon className="size-5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Gmail</p>
                    <p className="text-sm break-all text-muted-foreground">
                      {c.account}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {c.status === "connected"
                        ? "Cuenta conectada"
                        : "Necesita volver a conectarse"}
                    </p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={disabled || busy}
                  onClick={() => setRemove(c.id)}
                >
                  Desconectar
                </Button>
              </div>
            ))
          ) : (
            <CardEmptyState title="Sin cuentas conectadas">
              Conecta Gmail para leer correos y preparar acciones que tú
              confirmarás.
            </CardEmptyState>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={disabled || busy || state.available === false}
            onClick={() => setConnecting(true)}
          >
            <PlusIcon aria-hidden="true" />
            Conectar Gmail
          </Button>
          {state.available === false && (
            <p className="text-sm text-muted-foreground">
              La conexión necesita completar su configuración en Agentonic.
            </p>
          )}
        </div>
      </AgentSettingsCard>
      <AgentSettingsCard
        title="Herramientas"
        icon={<WrenchIcon />}
        description="Selecciona las operaciones de Gmail que incluirá la próxima versión."
        footer="Guarda el borrador y prepara una nueva versión para revisar cambios de acceso. Puedes probarlas en Probar agente antes de enviar la versión a revisión. Crear, editar o eliminar borradores y enviar correos siempre requiere tu confirmación."
      >
        {state.connections.some((c) => c.status === "connected") && (
          <div className="mb-4">
            <Select
              items={state.connections
                .filter((c) => c.status === "connected")
                .map((c) => ({ value: c.id, label: c.account }))}
              value={connection?.id ?? ""}
              disabled={disabled || busy}
              onValueChange={(value) => {
                setChosenAccount(value ?? "")
                onTools([])
              }}
            >
              <SelectTrigger aria-label="Cuenta de Gmail para las herramientas">
                <SelectValue placeholder="Selecciona una cuenta" />
              </SelectTrigger>
              <SelectContent>
                {state.connections
                  .filter((c) => c.status === "connected")
                  .map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.account}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        )}
        {!connection ? (
          <CardEmptyState title="Conecta una cuenta primero">
            Las herramientas estarán disponibles cuando conectes Gmail.
          </CardEmptyState>
        ) : (
          <fieldset
            disabled={disabled || busy}
            className="grid gap-3 sm:grid-cols-2"
          >
            <legend className="mb-4 text-sm text-muted-foreground">
              Cuenta: {connection.account}
            </legend>
            {gmailOperation.options.map((op) => (
              <label
                key={op}
                className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm"
              >
                <Checkbox.Root
                  checked={
                    selected?.connectionId === connection.id &&
                    selected.operations.includes(op)
                  }
                  onCheckedChange={(checked) => void permission(op, checked)}
                  className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border data-checked:bg-primary data-checked:text-primary-foreground"
                >
                  <Checkbox.Indicator>
                    <CheckIcon className="size-3" />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <span>{gmailLabels[op]}</span>
              </label>
            ))}
          </fieldset>
        )}
      </AgentSettingsCard>
      <Dialog open={connecting} onOpenChange={setConnecting}>
        <DialogContent>
          <DialogTitle>Conectar Gmail</DialogTitle>
          <DialogDescription>
            Google te pedirá permiso para leer correos y administrar borradores.
            Su permiso de borradores también permite enviar; Agentonic exigirá
            una confirmación por cada cambio.
          </DialogDescription>
          <p className="text-sm text-muted-foreground">
            Después elegirás las herramientas de este agente. Los adjuntos y la
            importación del buzón no están incluidos.
          </p>
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setConnecting(false)}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              onClick={() => {
                const form = document.createElement("form")
                form.method = "POST"
                form.action = `/api/connections/google/start?workspace=${workspaceId}&agent=${agentId}`
                document.body.appendChild(form)
                form.submit()
              }}
            >
              Continuar con Google
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={!!remove} onOpenChange={(open) => !open && setRemove(null)}>
        <DialogContent>
          <DialogTitle>Desconectar Gmail</DialogTitle>
          <DialogDescription>
            El agente perderá acceso inmediatamente y las acciones pendientes se
            cancelarán. Las versiones anteriores conservarán su historial.
          </DialogDescription>
          <div className="flex justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRemove(null)}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                if (!remove) return
                setBusy(true)
                try {
                  const result = await gmailCommand(workspaceId, "disconnect", {
                    connectionId: remove,
                  })
                  if (selected?.connectionId === remove) onTools([])
                  setRemove(null)
                  notify.success(
                    result.revoked
                      ? "Gmail desconectado."
                      : "Acceso en Agentonic retirado. Revisa también los permisos de la aplicación en tu cuenta de Google."
                  )
                  router.refresh()
                } catch (e) {
                  notify.destructive(
                    e instanceof Error ? e.message : "No se pudo desconectar."
                  )
                } finally {
                  setBusy(false)
                }
              }}
            >
              Desconectar
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
