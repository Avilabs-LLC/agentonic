"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import {
  CheckIcon,
  CircleCheckIcon,
  FilePlusIcon,
  FileTextIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { Checkbox } from "@base-ui/react/checkbox"
import {
  driveLabels,
  driveOperation,
  driveTypes,
  pickerSession,
  type DriveFile,
  type DriveGrant,
  type DriveOperation,
  type DriveState,
  type PickerSession,
} from "@agentonic/contracts/drive"
import { Button } from "@workspace/ui/components/button"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Tabs,
  TabsBar,
  TabsContent,
  TabsTrigger,
} from "@workspace/ui/components/tabs"
import { DriveIcon } from "@workspace/ui/components/drive-icon"
import { iconTones } from "@workspace/ui/components/status-badge"
import { notify } from "@workspace/ui/lib/toast"
import { cn } from "cn"

// Google Drive in Configuración and Conocimiento (architecture §62).
export async function driveCommand(
  workspace: string,
  operation: string,
  payload: Record<string, unknown>
) {
  const response = await fetch(`/api/drive?workspace=${workspace}`, {
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

/** An account's identity and connection state: Drive's logo, the address and a check. */
export function DriveAccount({
  account,
  status,
}: {
  account: string
  status: "connected" | "reconnect" | "disconnected"
}) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <DriveIcon className="size-6 shrink-0" />
      <div className="min-w-0">
        <p className="text-sm font-medium">Google Drive</p>
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

// Google's Picker -----------------------------------------------------------------
type PickerData = { action: string; docs?: { id: string }[] }
type PickerApi = {
  ViewId: { DOCS: string }
  Feature: { MULTISELECT_ENABLED: string }
  Action: { PICKED: string; CANCEL: string }
  DocsView: new (view: string) => {
    setMimeTypes(types: string): unknown
    setIncludeFolders(on: boolean): unknown
    setSelectFolderEnabled(on: boolean): unknown
  }
  PickerBuilder: new () => Record<string, (...args: unknown[]) => unknown> & {
    build(): { setVisible(on: boolean): void }
  }
}
declare global {
  interface Window {
    gapi?: {
      load(
        name: string,
        options: { callback: () => void; onerror: () => void }
      ): void
    }
    google?: { picker?: PickerApi }
  }
}
let loading: Promise<PickerApi> | undefined
/** Loads Google's Picker on demand; the app's own script inserts it (CSP §53). */
function loadPicker() {
  loading ??= new Promise<PickerApi>((resolve, reject) => {
    const ready = () =>
      window.gapi!.load("picker", {
        callback: () =>
          window.google?.picker
            ? resolve(window.google.picker)
            : reject(new Error("picker")),
        onerror: () => reject(new Error("picker")),
      })
    if (window.gapi) return ready()
    const script = document.createElement("script")
    script.src = "https://apis.google.com/js/api.js"
    script.async = true
    script.onload = ready
    script.onerror = () => reject(new Error("picker"))
    document.head.appendChild(script)
  }).catch((error) => {
    loading = undefined
    throw error
  })
  return loading
}
/**
 * Opens Google's Picker for one connected account and returns the picked
 * file IDs. Only files, in the formats Agentonic reads; never folders, since
 * Google does not say that picking a folder shares what is inside it.
 */
export async function pickDriveFiles(session: PickerSession, title: string) {
  const picker = await loadPicker()
  return new Promise<string[]>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.DOCS)
    view.setMimeTypes(Object.keys(driveTypes).join(","))
    view.setIncludeFolders(false)
    view.setSelectFolderEnabled(false)
    const builder = new picker.PickerBuilder()
    builder.addView!(view)
    builder.enableFeature!(picker.Feature.MULTISELECT_ENABLED)
    builder.setOAuthToken!(session.token)
    builder.setDeveloperKey!(session.apiKey)
    builder.setAppId!(session.appId)
    builder.setLocale!("es")
    builder.setTitle!(title)
    builder.setCallback!((data: PickerData) => {
      if (data.action === picker.Action.PICKED)
        resolve((data.docs ?? []).map((d) => d.id))
      else if (data.action === picker.Action.CANCEL) resolve([])
    })
    builder.build().setVisible(true)
  })
}
/** Asks the server for a Picker session, opens it, and returns what was picked. */
export async function chooseDriveFiles(
  workspaceId: string,
  connectionId: string,
  title: string
) {
  const session = pickerSession.parse(
    await driveCommand(workspaceId, "picker", { connectionId })
  )
  return pickDriveFiles(session, title)
}
/** One notification for what the server kept and what Drive refused. */
export function notifyPicked(result: Record<string, unknown>) {
  if (result.ok === false) {
    notify.destructive(
      result.code === "too_many_files"
        ? "Se alcanzó el límite de archivos de esta cuenta."
        : "No se pudieron agregar los archivos."
    )
    return
  }
  const added = Number(result.added ?? 0),
    refused = (result.refused as { reason: string }[] | undefined) ?? []
  const summary =
    added === 1 ? "Se agregó 1 archivo." : `Se agregaron ${added} archivos.`
  if (refused.length)
    notify.warning(
      `${summary} ${refused.length === 1 ? "Uno no se agregó" : `${refused.length} no se agregaron`}: ${[...new Set(refused.map((r) => r.reason.toLowerCase()))].join(", ")}.`
    )
  else notify.success(summary)
}
export const startDriveConnection = (
  workspaceId: string,
  purpose: "tools" | "knowledge",
  agentId?: string
) => {
  const form = document.createElement("form")
  form.method = "POST"
  form.action = `/api/connections/google/start?provider=drive&purpose=${purpose}&workspace=${workspaceId}${agentId ? `&agent=${agentId}` : ""}`
  document.body.appendChild(form)
  form.submit()
}

// Configuración ------------------------------------------------------------------
/** The files an agent may reach in one Drive account, with Elegir archivos. */
export function DriveFiles({
  workspaceId,
  agentId,
  connectionId,
  files,
  disabled,
  picker,
}: {
  workspaceId: string
  agentId: string
  connectionId: string
  files: DriveFile[]
  disabled: boolean
  /** Whether this server has the Picker's settings. */
  picker: boolean
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false)
  async function choose() {
    setBusy(true)
    try {
      const ids = await chooseDriveFiles(
        workspaceId,
        connectionId,
        "Elige los archivos que el agente podrá leer"
      )
      if (!ids.length) return
      notifyPicked(
        await driveCommand(workspaceId, "files.add", {
          agentId,
          connectionId,
          fileIds: ids,
        })
      )
      router.refresh()
    } catch (e) {
      notify.destructive(
        e instanceof Error && e.message !== "picker"
          ? e.message
          : "No se pudo abrir el selector de Google Drive."
      )
    } finally {
      setBusy(false)
    }
  }
  async function remove(fileId: string) {
    setBusy(true)
    try {
      await driveCommand(workspaceId, "files.remove", {
        agentId,
        connectionId,
        fileId,
      })
      notify.success("El agente ya no puede leer ese archivo.")
      router.refresh()
    } catch (e) {
      notify.destructive(
        e instanceof Error ? e.message : "No se pudo quitar el archivo."
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          Archivos del agente{" "}
          <span className="font-normal text-muted-foreground tabular-nums">
            {files.length}
          </span>
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy || !picker}
          onClick={() => void choose()}
        >
          <FilePlusIcon aria-hidden="true" />
          Elegir archivos
        </Button>
      </div>
      {!picker && (
        <p className="text-sm text-muted-foreground">
          El selector de Google Drive necesita completar su configuración en
          Agentonic.
        </p>
      )}
      {files.length ? (
        <ul className="divide-y rounded-lg border">
          {files.map((f) => (
            <li
              key={f.fileId}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileTextIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm">{f.name}</span>
                  <span className="block text-xs text-muted-foreground">
                    {driveTypes[f.mimeType] ?? "Archivo"}
                    {f.origin === "created" && " · Creado por el agente"}
                  </span>
                </span>
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={disabled || busy}
                aria-label={`Quitar ${f.name}`}
                onClick={() => void remove(f.fileId)}
              >
                <XIcon aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <CardEmptyState title="Sin archivos elegidos">
          El agente solo puede leer los archivos que elijas aquí y los
          documentos que cree con tu confirmación.
        </CardEmptyState>
      )}
    </div>
  )
}

/**
 * Herramientas › Google Drive: one tab per connected account, titled with the
 * address and how many of its tools are on. An agent uses Drive through one
 * account at a time, as with Gmail.
 */
export function DriveTools({
  connections,
  grant,
  disabled,
  onPermission,
}: {
  connections: { id: string; account: string }[]
  grant: DriveGrant | undefined
  disabled: boolean
  onPermission: (
    connectionId: string,
    op: DriveOperation,
    checked: boolean
  ) => void
}) {
  const [tab, setTab] = useState(
    grant?.driveConnectionId ?? connections[0]?.id ?? ""
  )
  const shown = connections.find((c) => c.id === tab) ?? connections[0]
  const total = driveOperation.options.length
  const holder = connections.find((c) => c.id === grant?.driveConnectionId)
  return (
    <div className="mt-5 space-y-4 border-t pt-5">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <DriveIcon className="size-4 shrink-0" />
        Google Drive
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
          Conecta Google Drive para que el agente lea los archivos que elijas y
          prepare documentos que tú confirmarás.
        </CardEmptyState>
      ) : (
        <Tabs
          value={shown.id}
          onValueChange={(value) => setTab(String(value))}
          className="gap-4"
        >
          <TabsBar aria-label="Cuentas de Google Drive">
            {connections.map((c) => (
              <TabsTrigger key={c.id} value={c.id} className="flex-none px-3">
                {c.account}
                <span className="text-xs text-muted-foreground tabular-nums">
                  {grant?.driveConnectionId === c.id
                    ? grant.operations.length
                    : 0}
                  /{total}
                </span>
              </TabsTrigger>
            ))}
          </TabsBar>
          {connections.map((c) => (
            <TabsContent key={c.id} value={c.id}>
              {holder && holder.id !== c.id && (
                <p className="mb-3 text-sm text-muted-foreground">
                  El agente usa Google Drive con una sola cuenta. Elegir una
                  herramienta aquí quitará las de {holder.account}.
                </p>
              )}
              <fieldset
                disabled={disabled}
                className="grid gap-3 sm:grid-cols-2"
              >
                <legend className="sr-only">
                  Herramientas de Google Drive para {c.account}
                </legend>
                {driveOperation.options.map((op) => (
                  <label
                    key={op}
                    className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm"
                  >
                    <Checkbox.Root
                      checked={
                        grant?.driveConnectionId === c.id &&
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
                    <span>{driveLabels[op]}</span>
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

/** What connecting Drive shares, before Google asks. */
export function DriveConnectDialog({
  open,
  onOpenChange,
  purpose,
  onContinue,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  purpose: "tools" | "knowledge"
  onContinue: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Conectar Google Drive</DialogTitle>
          <DialogDescription>
            Google te pedirá permiso para ver y administrar solo los archivos
            que elijas en Agentonic y los documentos que Agentonic cree.
            Agentonic no podrá ver el resto de tu Drive.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {purpose === "tools"
            ? "Después elegirás los archivos y las herramientas de este agente. Crear o editar un documento siempre requiere tu confirmación."
            : "Después elegirás los archivos que se agregan a una colección. Se revisan cada hora y sus cambios se actualizan en Conocimiento."}
        </p>
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button type="button" onClick={onContinue}>
            Continuar con Google
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
/** Disconnects one Drive account after saying what it ends. */
export function DriveDisconnectDialog({
  workspaceId,
  connectionId,
  purpose,
  files,
  onClose,
  onDisconnected,
}: {
  workspaceId: string
  connectionId: string | null
  purpose: "tools" | "knowledge"
  files: number
  onClose: () => void
  onDisconnected: () => void
}) {
  const [busy, setBusy] = useState(false)
  return (
    <Dialog
      open={!!connectionId}
      onOpenChange={(open) => !open && !busy && onClose()}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Desconectar Google Drive</DialogTitle>
          <DialogDescription>
            {purpose === "tools"
              ? "El agente perderá acceso de inmediato, se quitarán sus archivos elegidos y las acciones pendientes se cancelarán."
              : files === 1
                ? "Se quitará de Conocimiento el archivo importado con esta cuenta. Las versiones que lo usan dejarán de responder hasta preparar una nueva."
                : `Se quitarán de Conocimiento los ${files} archivos importados con esta cuenta. Las versiones que los usan dejarán de responder hasta preparar una nueva.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              if (!connectionId) return
              setBusy(true)
              try {
                const result = await driveCommand(workspaceId, "disconnect", {
                  connectionId,
                })
                notify.success(
                  result.revoked
                    ? "Google Drive desconectado."
                    : "Acceso en Agentonic retirado. La cuenta sigue autorizada en Google porque otra conexión de Agentonic la usa, o puedes retirarla en los permisos de tu cuenta de Google."
                )
                onDisconnected()
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
  )
}
export type { DriveState }
