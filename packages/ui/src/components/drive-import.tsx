"use client"
import { useState } from "react"
import { googleGrantState } from "@agentonic/contracts/google-grant"
import { useRouter } from "next/navigation"
import {
  ExternalLinkIcon,
  FilePlusIcon,
  PlusIcon,
  RefreshCwIcon,
  SquareCheckIcon,
  Trash2Icon,
} from "lucide-react"
import {
  driveTypes,
  type DriveKnowledgeFile,
  type DriveKnowledgeView,
} from "@agentonic/contracts/drive"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { Button } from "@workspace/ui/components/button"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import { DataTableRowActions } from "@workspace/ui/components/data-table-row-actions"
import {
  DriveAccount,
  DriveBrowserNote,
  DriveConnectDialog,
  DriveDisconnectDialog,
  DriveReturnNotice,
  chooseDriveFiles,
  driveCommand,
  notifyPicked,
  pickOnGooglePage,
  startDriveConnection,
} from "@workspace/ui/components/drive-connection"
import { DriveIcon } from "@workspace/ui/components/drive-icon"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { DomainStatus } from "@workspace/ui/components/status-badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { When } from "@workspace/ui/components/table-cells"
import { notify } from "@workspace/ui/lib/toast"

// Conocimiento › Google Drive (architecture §62): a curator's own Drive
// account, separate from any agent's tools, imports picked files into a
// collection they curate. Each file is checked hourly.
const problems: Record<string, string> = {
  not_found: "Ya no existe o no se comparte con Agentonic.",
  no_access: "Google Drive no permite a Agentonic leerlo.",
  trashed: "Está en la papelera de Google Drive.",
  unsupported: "Su formato ya no es compatible.",
  too_large: "Supera 10 MB.",
  reconnect: "La cuenta necesita volver a conectarse para sincronizar.",
}
const actionResult = async (run: () => Promise<Record<string, unknown>>) => {
  try {
    const r = await run()
    if (r.ok === false)
      return {
        ok: false as const,
        message:
          r.code === "reconnect"
            ? "La cuenta de Google Drive necesita volver a conectarse."
            : r.code === "rate_limit"
              ? "Se sincronizó hace un momento. Inténtalo en un minuto."
              : "No se pudo completar la acción.",
      }
    return { ok: true as const }
  } catch (e) {
    return {
      ok: false as const,
      message:
        e instanceof Error ? e.message : "No se pudo completar la acción.",
    }
  }
}

export function DriveImport({
  workspaceId,
  state,
  collections,
  collectionNames,
}: {
  workspaceId: string
  state: DriveKnowledgeView
  /** Collections the member curates, where files may be imported. */
  collections: { id: string; name: string }[]
  /** Every collection the member can read, for naming an import's collection. */
  collectionNames: Record<string, string>
}) {
  const router = useRouter(),
    [busy, setBusy] = useState(false),
    [connecting, setConnecting] = useState(false),
    [remove, setRemove] = useState<string | null>(null),
    [collectionId, setCollectionId] = useState(collections[0]?.id ?? ""),
    connected = state.connections.filter((c) => c.status === "connected"),
    [accountId, setAccountId] = useState(connected[0]?.id ?? "")
  const account = connected.find((c) => c.id === accountId) ?? connected[0]
  async function choose() {
    if (!account || !collectionId) return
    setBusy(true)
    if (pickOnGooglePage())
      return startDriveConnection(workspaceId, "knowledge", undefined, {
        connectionId: account.id,
        collectionId,
      })
    try {
      const ids = await chooseDriveFiles(
        workspaceId,
        account.id,
        "Elige los archivos que se agregan a la colección"
      )
      if (!ids.length) return
      notifyPicked(
        await driveCommand(workspaceId, "knowledge.add", {
          connectionId: account.id,
          collectionId,
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
  const act = (operation: string, file: DriveKnowledgeFile) => async () => {
    const result = await actionResult(() =>
      driveCommand(workspaceId, operation, { sourceId: file.sourceId })
    )
    if (result.ok) router.refresh()
    return result
  }
  const held = state.files.some((f) => f.status === "held")
  return (
    <AgentSettingsCard
      title="Google Drive"
      icon={<DriveIcon />}
      description="Importa archivos de tu Google Drive a una colección. Se revisan cada hora y sus cambios se actualizan en Conocimiento."
      footer="Agentonic solo ve los archivos que elijas aquí. Los documentos de Google se importan como Markdown, las hojas de cálculo como CSV (su primera hoja) y las presentaciones como texto; también PDF, texto y Markdown de hasta 10 MB. Esta cuenta es distinta de las herramientas de Drive de cada agente."
    >
      <div className="space-y-5">
        <DriveReturnNotice />
        {state.connections.map((c) => (
          <div
            key={c.id}
            className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
          >
            <DriveAccount
              account={c.account}
              status={c.status}
              expiresAt={c.expiresAt}
            />
            <div className="flex flex-wrap gap-2">
              {googleGrantState(c.status, c.expiresAt).kind !== "connected" && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConnecting(true)}
                >
                  Volver a conectar
                </Button>
              )}
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => setRemove(c.id)}
              >
                Desconectar
              </Button>
            </div>
          </div>
        ))}
        {!state.connections.length && (
          <CardEmptyState title="Sin cuenta de Google Drive">
            Conecta tu Google Drive para elegir archivos y mantenerlos al día en
            una colección.
          </CardEmptyState>
        )}
        {account ? (
          <div className="grid items-end gap-4 sm:grid-cols-[1fr_auto]">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="drive-import-collection">
                  Colección
                </FieldLabel>
                <Select
                  value={collectionId || null}
                  onValueChange={(value) => setCollectionId(value ?? "")}
                  items={collections.map((c) => ({
                    value: c.id,
                    label: c.name,
                  }))}
                >
                  <SelectTrigger
                    id="drive-import-collection"
                    className="w-full"
                  >
                    <SelectValue placeholder="Seleccionar colección" />
                  </SelectTrigger>
                  <SelectContent>
                    {collections.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              {connected.length > 1 && (
                <Field>
                  <FieldLabel htmlFor="drive-import-account">Cuenta</FieldLabel>
                  <Select
                    value={account.id}
                    onValueChange={(value) => setAccountId(value ?? "")}
                    items={connected.map((c) => ({
                      value: c.id,
                      label: c.account,
                    }))}
                  >
                    <SelectTrigger id="drive-import-account" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="w-auto max-w-(--available-width) min-w-(--anchor-width)">
                      {connected.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.account}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              )}
            </div>
            <Button
              type="button"
              disabled={
                busy ||
                !collectionId ||
                state.picker === false ||
                !collections.length
              }
              onClick={() => void choose()}
            >
              <FilePlusIcon aria-hidden="true" />
              Elegir archivos
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            disabled={busy || state.available === false || !collections.length}
            onClick={() => setConnecting(true)}
            aria-label="Conectar Google Drive"
          >
            <PlusIcon aria-hidden="true" />
            <DriveIcon className="size-4 shrink-0" />
            Google Drive
          </Button>
        )}
        {account && state.picker !== false && <DriveBrowserNote />}
        {(state.available === false || (account && state.picker === false)) && (
          <p className="text-sm text-muted-foreground">
            Google Drive necesita completar su configuración en Agentonic.
          </p>
        )}
        {!collections.length && (
          <p className="text-sm text-muted-foreground">
            Crea una colección o solicita permiso para gestionar una existente.
          </p>
        )}
        {state.files.length > 0 && (
          <div className="space-y-3">
            <div className="overflow-x-auto rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Documento</TableHead>
                    <TableHead>Colección</TableHead>
                    <TableHead>Estado</TableHead>
                    <TableHead>Revisado</TableHead>
                    <TableHead className="w-10">
                      <span className="sr-only">Acciones</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {state.files.map((f) => (
                    <TableRow key={f.sourceId}>
                      <TableCell>
                        <span className="block max-w-72 truncate">
                          {f.url ? (
                            <a
                              href={f.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 text-link underline-offset-4 hover:underline"
                            >
                              {f.name}
                              <ExternalLinkIcon
                                className="size-3 shrink-0"
                                aria-hidden="true"
                              />
                              <span className="sr-only">
                                (abre Google Drive)
                              </span>
                            </a>
                          ) : (
                            f.name
                          )}
                        </span>
                        <span className="block text-muted-foreground">
                          {driveTypes[f.mimeType] ?? "Archivo"}
                          {f.errorCode && problems[f.errorCode]
                            ? ` · ${problems[f.errorCode]}`
                            : ""}
                        </span>
                      </TableCell>
                      <TableCell>
                        {collectionNames[f.collectionId] ?? "Colección"}
                      </TableCell>
                      <TableCell>
                        <DomainStatus
                          domain="driveSync"
                          status={f.status}
                          appearance="badge"
                        />
                      </TableCell>
                      <TableCell>
                        <When value={f.checkedAt} empty="Pendiente" />
                      </TableCell>
                      <TableCell>
                        {f.canManage && (
                          <DataTableRowActions
                            actions={[
                              {
                                label: "Sincronizar ahora",
                                icon: <RefreshCwIcon />,
                                disabled:
                                  f.status === "queued" ||
                                  f.status === "syncing" ||
                                  f.connectionStatus !== "connected",
                                run: act("knowledge.sync", f),
                                successMessage:
                                  "Sincronización en cola. Se revisará en unos instantes.",
                              },
                              ...(f.status === "held"
                                ? [
                                    {
                                      label: "Aplicar cambios",
                                      icon: <SquareCheckIcon />,
                                      run: act("knowledge.apply", f),
                                      successMessage:
                                        "Cambios en cola para aplicarse.",
                                      confirm: {
                                        title:
                                          "Aplicar los cambios de Google Drive",
                                        description: `${f.citedBy.length ? `${f.citedBy.map((a) => a.name).join(", ")} ${f.citedBy.length === 1 ? "usa" : "usan"}` : "Una versión en uso o aprobada usa"} el texto actual de este documento como evidencia. Al aplicar los cambios, esas versiones dejarán de responder hasta que prepares y apruebes una nueva.`,
                                        confirmLabel: "Aplicar cambios",
                                      },
                                    },
                                  ]
                                : []),
                              {
                                label: "Quitar de Conocimiento",
                                icon: <Trash2Icon />,
                                destructive: true,
                                run: act("knowledge.remove", f),
                                successMessage:
                                  "Archivo quitado de Conocimiento.",
                                confirm: {
                                  title: "Quitar de Conocimiento",
                                  description:
                                    "El texto del archivo se borrará de la colección; el archivo sigue en tu Google Drive. Las versiones que lo usan dejarán de responder hasta preparar una nueva.",
                                  confirmLabel: "Quitar archivo",
                                },
                              },
                            ]}
                          />
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {held && (
              <p className="text-sm text-muted-foreground">
                Cambios en Drive sin aplicar: una versión en uso o aprobada cita
                el texto actual, así que el cambio espera a que lo apliques.
                Mientras tanto el agente sigue respondiendo con el texto
                aprobado.
              </p>
            )}
          </div>
        )}
      </div>
      <DriveConnectDialog
        open={connecting}
        onOpenChange={setConnecting}
        purpose="knowledge"
        onContinue={() => startDriveConnection(workspaceId, "knowledge")}
      />
      <DriveDisconnectDialog
        workspaceId={workspaceId}
        connectionId={remove}
        purpose="knowledge"
        files={state.connections.find((c) => c.id === remove)?.files ?? 0}
        onClose={() => setRemove(null)}
        onDisconnected={() => {
          setRemove(null)
          router.refresh()
        }}
      />
    </AgentSettingsCard>
  )
}
