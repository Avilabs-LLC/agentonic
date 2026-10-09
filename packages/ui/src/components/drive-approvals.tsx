"use client"
import { useEffect, useState } from "react"
import { ExternalLinkIcon } from "lucide-react"
import {
  driveInvocation,
  driveLabels,
  type DriveInvocation,
} from "@agentonic/contracts/drive"
import { formatUtcDateTime } from "@agentonic/contracts/format"
import { driveCommand } from "@workspace/ui/components/drive-connection"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import { ConsentCheckbox } from "@workspace/ui/components/consent-checkbox"
import { MarkdownView } from "@workspace/ui/components/markdown"

// Google Docs changes an agent proposed in a chat or a private test (§62),
// each confirmed once by the person who connected the account.
const labels = {
  pending: "Pendiente de confirmación",
  executing: "Comprobando resultado",
  succeeded: "Completada",
  failed: "No realizada",
  uncertain: "Resultado por verificar en Google Drive",
  cancelled: "Cancelada",
  expired: "Confirmación vencida",
}
const failures: Record<string, string> = {
  changed:
    "El documento cambió en Google Drive después de la propuesta; no se modificó.",
  not_found: "El documento ya no está disponible en Google Drive.",
  no_access: "Google Drive no permite a Agentonic modificar ese documento.",
  trashed: "El documento está en la papelera de Google Drive.",
}
type Current =
  | { ok: true; name: string; version: string; text: string }
  | { ok: false; code: string }
async function listInvocations(
  workspaceId: string,
  conversationId: string,
  context: "staging" | "preview"
) {
  const result = await driveCommand(workspaceId, "list", {
    conversationId,
    context,
  })
  return driveInvocation.array().parse(result.items)
}
const statusAt = (item: DriveInvocation, at: number) =>
  item.status === "pending" && Date.parse(item.expiresAt) <= at
    ? "expired"
    : item.status
const stillPending = (
  current: DriveInvocation | null,
  next: DriveInvocation[],
  at: number
) =>
  current &&
  next.some(
    (item) => item.id === current.id && statusAt(item, at) === "pending"
  )
    ? current
    : null
const args = (item: DriveInvocation) =>
  (item.arguments ?? {}) as Partial<{
    title: string
    body: string
    name: string
    id: string
  }>
const result = (item: DriveInvocation) =>
  (item.result ?? {}) as Partial<{ code: string; url: string }>

function Details({
  item,
  current,
}: {
  item: DriveInvocation
  current: Current | null | undefined
}) {
  const a = args(item)
  return (
    <div className="space-y-4 text-sm">
      <dl className="space-y-3">
        <div>
          <dt className="text-muted-foreground">Cuenta</dt>
          <dd className="break-all">{item.account}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {item.operation === "drive.docs.create" ? "Título" : "Documento"}
          </dt>
          <dd className="break-words">{a.title ?? a.name}</dd>
        </div>
      </dl>
      {item.operation === "drive.docs.update" && (
        <div className="space-y-2">
          {current === undefined ? (
            <p className="text-muted-foreground">
              Cargando el contenido actual…
            </p>
          ) : current === null || !current.ok ? (
            <p className="text-muted-foreground">
              {current && !current.ok && failures[current.code]
                ? failures[current.code]
                : "No se pudo leer el contenido actual. Puedes rechazar la acción o revisarlo en Google Drive."}
            </p>
          ) : (
            <MarkdownView
              label={
                <span className="text-muted-foreground">Contenido actual</span>
              }
              markdown={current.text}
              empty="El documento está vacío."
              paneClassName="max-h-[min(16rem,30dvh)]"
            />
          )}
        </div>
      )}
      <MarkdownView
        label={
          <span className="text-muted-foreground">
            {item.operation === "drive.docs.update"
              ? "Contenido propuesto (reemplaza todo el documento)"
              : "Contenido"}
          </span>
        }
        markdown={a.body ?? ""}
        paneClassName="max-h-[min(16rem,30dvh)]"
      />
    </div>
  )
}

export function DriveApprovals({
  workspaceId,
  conversationId,
  context = "staging",
}: {
  workspaceId: string
  conversationId: string
  context?: "staging" | "preview"
}) {
  const [items, setItems] = useState<DriveInvocation[]>([]),
    [selected, setSelected] = useState<DriveInvocation | null>(null),
    [current, setCurrent] = useState<Current | null | undefined>(undefined),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let active = true,
      inFlight = false
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const next = await listInvocations(workspaceId, conversationId, context)
        if (active) {
          const at = Date.now()
          setNow(at)
          setItems(next)
          setSelected((value) => stillPending(value, next, at))
        }
      } catch {
        if (active) {
          setItems([])
          setSelected(null)
        }
      } finally {
        inFlight = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), 3000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [workspaceId, conversationId, context])
  async function open(item: DriveInvocation) {
    setSelected(item)
    setConsent(false)
    setError("")
    setCurrent(undefined)
    if (item.operation !== "drive.docs.update") return
    try {
      setCurrent(
        (await driveCommand(workspaceId, "current", {
          id: item.id,
          hash: item.hash,
        })) as Current
      )
    } catch {
      setCurrent(null)
    }
  }
  async function run(operation: "confirm" | "cancel", item: DriveInvocation) {
    setBusy(true)
    setError("")
    try {
      await driveCommand(workspaceId, operation, {
        id: item.id,
        hash: item.hash,
      })
      setSelected(null)
      setItems(await listInvocations(workspaceId, conversationId, context))
    } catch (e) {
      const next = await listInvocations(
        workspaceId,
        conversationId,
        context
      ).catch(() => null)
      const at = Date.now(),
        latest = next?.find((entry) => entry.id === item.id),
        status = latest && statusAt(latest, at)
      if (next) {
        setNow(at)
        setItems(next)
        setSelected((value) => stillPending(value, next, at))
      }
      setError(
        status && status !== "pending"
          ? `Esta acción ya no está pendiente (${labels[status]}). ${status === "cancelled" || status === "expired" ? "No se ejecutó." : "No se volvió a ejecutar."}`
          : e instanceof Error
            ? e.message
            : "Revisa el resultado antes de volver a intentarlo."
      )
    } finally {
      setBusy(false)
    }
  }
  if (!items.length && !error) return null
  return (
    <div className="my-5 space-y-3" aria-label="Acciones de Google Drive">
      {items.map((item) => {
        const status = statusAt(item, now),
          r = result(item)
        return (
          <div
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-4"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {driveLabels[item.operation]}
                {(args(item).title ?? args(item).name) && (
                  <span className="font-normal text-muted-foreground">
                    {" "}
                    · {args(item).title ?? args(item).name}
                  </span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {labels[status]} · {item.account}
                {item.automatic && " · Autorizada por la programación"}
              </p>
              {status === "failed" && r.code && failures[r.code] && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {failures[r.code]}
                </p>
              )}
              {status === "uncertain" && (
                <p className="mt-2 text-sm text-muted-foreground">
                  Comprueba Google Drive antes de solicitar otra acción. No se
                  repetirá automáticamente.
                </p>
              )}
            </div>
            {status === "pending" ? (
              <Button variant="outline" onClick={() => void open(item)}>
                Revisar acción
              </Button>
            ) : (
              status === "succeeded" &&
              r.url && (
                <Button
                  variant="link"
                  nativeButton={false}
                  render={
                    <a href={r.url} target="_blank" rel="noopener noreferrer" />
                  }
                >
                  Abrir en Google Drive
                  <ExternalLinkIcon aria-hidden="true" />
                </Button>
              )
            )}
          </div>
        )
      })}
      {error && !selected && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(value) => !busy && !value && setSelected(null)}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {selected ? driveLabels[selected.operation] : "Revisar acción"}
            </DialogTitle>
            <DialogDescription>
              {selected?.operation === "drive.docs.update"
                ? "Confirma este cambio exacto. Si el documento cambia en Google Drive antes de confirmar, no se modificará."
                : "Confirma este documento exacto. Cambiar el título o el contenido requiere una nueva confirmación."}
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <>
              <Details item={selected} current={current} />
              <p className="text-xs text-muted-foreground">
                Válida hasta {formatUtcDateTime(selected.expiresAt)} UTC.
              </p>
              <ConsentCheckbox
                checked={consent}
                onCheckedChange={setConsent}
                disabled={busy}
              >
                Autorizo este cambio en mi cuenta de Google Drive.
              </ConsentCheckbox>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-3">
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run("cancel", selected)}
                >
                  Rechazar
                </Button>
                <Button
                  disabled={busy || !consent}
                  onClick={() => void run("confirm", selected)}
                >
                  {busy
                    ? "Procesando…"
                    : selected.operation === "drive.docs.create"
                      ? "Confirmar y crear"
                      : "Confirmar y reemplazar"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
