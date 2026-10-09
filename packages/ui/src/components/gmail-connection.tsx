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
  Tabs,
  TabsBar,
  TabsTrigger,
  TabsContent,
} from "@workspace/ui/components/tabs"
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
type Grant = { connectionId: string; operations: string[] }
/**
 * Herramientas › Gmail: one tab per connected account, titled with the
 * address and how many of its tools are on. Tabs scroll sideways, so many
 * accounts fit. An agent uses Gmail through one account at a time.
 */
export function GmailTools({
  connections,
  grant,
  disabled,
  onPermission,
}: {
  connections: { id: string; account: string }[]
  grant: Grant | undefined
  disabled: boolean
  onPermission: (
    connectionId: string,
    op: (typeof gmailOperation.options)[number],
    checked: boolean
  ) => void
}) {
  const [tab, setTab] = useState(
    grant?.connectionId ?? connections[0]?.id ?? ""
  )
  const shown = connections.find((c) => c.id === tab) ?? connections[0]
  const total = gmailOperation.options.length
  const holder = connections.find((c) => c.id === grant?.connectionId)
  return (
    <div className="mt-5 space-y-4 border-t pt-5">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <GmailIcon className="size-4 shrink-0" />
        Gmail
        <span className="text-xs font-normal text-muted-foreground tabular-nums">
          {connections.length}
          <span className="sr-only">
            {connections.length === 1
              ? " cuenta conectada"
              : " cuentas conectadas"}
          </span>
        </span>
      </h3>
      {!shown ? (
        <CardEmptyState title="Conecta una cuenta primero">
          Conecta Gmail para habilitar herramientas de correo. El acceso web
          funciona de forma independiente.
        </CardEmptyState>
      ) : (
        <Tabs
          value={shown.id}
          onValueChange={(value) => setTab(String(value))}
          className="gap-4"
        >
          <TabsBar aria-label="Cuentas de Gmail">
            {connections.map((c) => (
              <TabsTrigger key={c.id} value={c.id} className="flex-none px-3">
                {c.account}
                <span className="text-xs text-muted-foreground tabular-nums">
                  {grant?.connectionId === c.id ? grant.operations.length : 0}/
                  {total}
                </span>
              </TabsTrigger>
            ))}
          </TabsBar>
          {connections.map((c) => (
            <TabsContent key={c.id} value={c.id}>
              {holder && holder.id !== c.id && (
                <p className="mb-3 text-sm text-muted-foreground">
                  El agente usa Gmail con una sola cuenta. Elegir una
                  herramienta aquí quitará las de {holder.account}.
                </p>
              )}
              <fieldset
                disabled={disabled}
                className="grid gap-3 sm:grid-cols-2"
              >
                <legend className="sr-only">
                  Herramientas de Gmail para {c.account}
                </legend>
                {gmailOperation.options.map((op) => (
                  <label
                    key={op}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm"
                  >
                    <Checkbox.Root
                      checked={
                        grant?.connectionId === c.id &&
                        grant.operations.includes(op)
                      }
                      onCheckedChange={(checked) =>
                        onPermission(c.id, op, checked)
                      }
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
            </TabsContent>
          ))}
        </Tabs>
      )}
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
  async function permission(
    connectionId: string,
    op: (typeof gmailOperation.options)[number],
    checked: boolean
  ) {
    // One account per agent: ticking another account's tool moves the grant.
    const own = selected?.connectionId === connectionId ? selected : undefined
    const operations = checked
      ? [...(own?.operations ?? []), op]
      : (own?.operations ?? []).filter((o) => o !== op)
    setBusy(true)
    try {
      await gmailCommand(workspaceId, "permissions", {
        agentId,
        connectionId,
        operations,
      })
      onGmailTools(operations.length ? [{ connectionId, operations }] : [])
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
            <span className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium">Acceso web</span>
              <span className="text-xs text-muted-foreground">
                Solo lectura
              </span>
            </span>
            <span className="block text-sm text-muted-foreground">
              Buscar información y leer páginas públicas con enlaces a las
              fuentes. No requiere conectar una cuenta.
            </span>
          </span>
        </label>
        <GmailTools
          connections={state.connections.filter(
            (c) => c.status === "connected"
          )}
          grant={selected}
          disabled={disabled || busy}
          onPermission={(connectionId, op, checked) =>
            void permission(connectionId, op, checked)
          }
        />
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
