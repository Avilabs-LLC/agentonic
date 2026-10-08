"use client"
import { gmailGrants, hasWeb } from "@agentonic/contracts/tools"
import { WEB_GRANT } from "@agentonic/contracts/web"
import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  PlugIcon,
  WrenchIcon,
  CheckIcon,
  CircleCheckIcon,
  PlusIcon,
  TriangleAlertIcon,
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
  DialogHeader,
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
import { GmailIcon } from "@workspace/ui/components/gmail-icon"
import { StyleLearning } from "@workspace/ui/components/style-learning"
import { iconTones } from "@workspace/ui/components/status-badge"
import { cn } from "cn"
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
/** An account's identity and connection state: Gmail's logo, the address and a check. */
export function GmailAccount({
  account,
  status,
}: {
  account: string
  status: GmailState["connections"][number]["status"]
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <GmailIcon className="size-6 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-medium">Gmail</p>
        <p className="text-sm break-all text-muted-foreground">{account}</p>
        <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
          {status === "connected" ? (
            <CircleCheckIcon
              className={cn("size-3.5", iconTones.success)}
              aria-hidden="true"
            />
          ) : (
            <TriangleAlertIcon
              className={cn("size-3.5", iconTones.warning)}
              aria-hidden="true"
            />
          )}
          {status === "connected"
            ? "Cuenta conectada"
            : "Necesita volver a conectarse"}
        </p>
      </div>
    </div>
  )
}
export function GmailConnection({
  state,
  workspaceId,
  agentId,
  tools,
  onTools,
  disabled,
  collections = [],
  agentCollectionIds = [],
}: {
  state: GmailState
  workspaceId: string
  agentId: string
  tools: AgentView["draft"]["requestedAccess"]["tools"]
  onTools: (tools: AgentView["draft"]["requestedAccess"]["tools"]) => void
  disabled: boolean
  /** Collections the member curates, for an accepted style guide (§57). */
  collections?: { id: string; name: string }[]
  agentCollectionIds?: string[]
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [connecting, setConnecting] = useState(false),
    [remove, setRemove] = useState<string | null>(null)
  const selected = gmailGrants(tools)[0]
  const webEnabled = hasWeb(tools)
  const onGmailTools = (value: typeof tools) =>
    onTools([...tools.filter((g) => "capability" in g), ...value])
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
      onGmailTools(
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
        footer="La cuenta es privada y solo tú puedes autorizar acciones. Conectarla no importa correos a Conocimiento; Aprender mi estilo solo agrega la guía que revises. Puedes habilitar sus herramientas al iniciar Probar agente; después de la activación también se usan desde Chats."
      >
        <div className="space-y-4">
          {state.connections.length ? (
            state.connections.map((c) => (
              <div key={c.id} className="space-y-4 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-4">
                  <GmailAccount account={c.account} status={c.status} />
                  <Button
                    type="button"
                    variant="outline"
                    disabled={disabled || busy}
                    onClick={() => setRemove(c.id)}
                  >
                    Desconectar
                  </Button>
                </div>
                {c.status === "connected" && (
                  <StyleLearning
                    workspaceId={workspaceId}
                    agentId={agentId}
                    connection={c}
                    initial={state.styleGuides.find(
                      (g) => g.connectionId === c.id
                    )}
                    collections={collections}
                    agentCollectionIds={agentCollectionIds}
                    disabled={disabled || busy}
                    onAccepted={() => router.refresh()}
                  />
                )}
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
        description="Elige qué puede hacer el agente en la próxima versión."
        footer="Guarda el borrador y prepara una nueva versión para revisar cambios de acceso. Puedes probarlas en Probar agente antes de enviar la versión a revisión. Crear, editar o eliminar borradores y enviar correos siempre requiere tu confirmación."
      >
        <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-4">
          <Checkbox.Root
            checked={webEnabled}
            disabled={disabled || busy}
            onCheckedChange={(checked) =>
              onTools(
                checked
                  ? [...gmailGrants(tools), WEB_GRANT]
                  : gmailGrants(tools)
              )
            }
            className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border data-checked:bg-primary data-checked:text-primary-foreground"
          >
            <Checkbox.Indicator>
              <CheckIcon className="size-3" />
            </Checkbox.Indicator>
          </Checkbox.Root>
          <span className="space-y-1">
            <span className="block text-sm font-medium">Acceso web</span>
            <span className="block text-sm text-muted-foreground">
              Buscar información y leer páginas públicas con enlaces a las
              fuentes. No requiere conectar una cuenta.
            </span>
            <span className="block text-xs text-muted-foreground">
              No inicia sesión ni completa formularios. Su uso está sujeto al
              presupuesto de la prueba. Desactivarlo y guardar retira el acceso
              de las versiones existentes.
            </span>
          </span>
        </label>
        <div className="mt-5 space-y-4 border-t pt-5">
          <h3 className="text-sm font-medium">Gmail</h3>
          {state.connections.some((c) => c.status === "connected") && (
            <div className="mb-4">
              <Select
                items={state.connections
                  .filter((c) => c.status === "connected")
                  .map((c) => ({ value: c.id, label: c.account }))}
                value={connection?.id ?? ""}
                disabled={disabled || busy}
                onValueChange={(value) => {
                  // Pressing the account already chosen keeps its tools.
                  if ((value ?? "") === (connection?.id ?? "")) return
                  setChosenAccount(value ?? "")
                  onGmailTools([])
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
              Conecta Gmail para habilitar herramientas de correo. El acceso web
              funciona de forma independiente.
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
        </div>
      </AgentSettingsCard>
      <Dialog open={connecting} onOpenChange={setConnecting}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Conectar Gmail</DialogTitle>
            <DialogDescription>
              Google te pedirá permiso para leer correos y administrar
              borradores. Su permiso de borradores también permite enviar;
              Agentonic exigirá una confirmación por cada cambio.
            </DialogDescription>
          </DialogHeader>
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
          <DialogHeader>
            <DialogTitle>Desconectar Gmail</DialogTitle>
            <DialogDescription>
              El agente perderá acceso inmediatamente y las acciones pendientes
              se cancelarán. Las versiones anteriores conservarán su historial.
            </DialogDescription>
          </DialogHeader>
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
                  if (selected?.connectionId === remove) onGmailTools([])
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
