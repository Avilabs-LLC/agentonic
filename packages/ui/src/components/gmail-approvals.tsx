"use client"
import { useEffect, useState } from "react"
import {
  gmailInvocation,
  gmailLabels,
  type GmailInvocation,
} from "@agentonic/contracts/gmail"
import { formatUtcDateTime } from "@agentonic/contracts/format"
import { gmailCommand } from "@workspace/ui/components/gmail-connection"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import { ConsentCheckbox } from "@workspace/ui/components/consent-checkbox"
const labels = {
  pending: "Pendiente de confirmación",
  executing: "Comprobando resultado",
  succeeded: "Completada",
  failed: "No realizada",
  uncertain: "Resultado por verificar en Gmail",
  cancelled: "Cancelada",
  expired: "Confirmación vencida",
}
function Details({ item }: { item: GmailInvocation }) {
  const args = (item.arguments ?? {}) as Record<string, unknown>,
    m = (args.message ?? args) as Record<string, unknown>
  return (
    <dl className="space-y-3 text-sm">
      <div>
        <dt className="text-muted-foreground">Cuenta</dt>
        <dd className="break-all">{item.account}</dd>
      </div>
      {[
        ...["id", "to", "cc", "bcc", "subject", "body"].filter(
          (k) => m[k] !== undefined && String(m[k]).length
        ),
      ].map((k) => (
        <div key={k}>
          <dt className="text-muted-foreground">
            {
              {
                id: "Borrador",
                to: "Para",
                cc: "CC",
                bcc: "CCO",
                subject: "Asunto",
                body: "Mensaje",
              }[k]
            }
          </dt>
          <dd className="max-h-64 overflow-y-auto break-words whitespace-pre-wrap">
            {Array.isArray(m[k]) ? (m[k] as string[]).join(", ") : String(m[k])}
          </dd>
        </div>
      ))}
      {Boolean(args.message) && (
        <div>
          <dt className="text-muted-foreground">Borrador</dt>
          <dd>{String(args.id)}</dd>
        </div>
      )}
    </dl>
  )
}
export function GmailApprovals({
  workspaceId,
  conversationId,
  context = "staging",
}: {
  workspaceId: string
  conversationId: string
  context?: "staging" | "preview"
}) {
  const [items, setItems] = useState<GmailInvocation[]>([]),
    [selected, setSelected] = useState<GmailInvocation | null>(null),
    [consent, setConsent] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  useEffect(() => {
    let active = true,
      inFlight = false
    const poll = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const result = await gmailCommand(workspaceId, "list", {
          conversationId,
          context,
        })
        if (active) {
          setItems(gmailInvocation.array().parse(result.items))
          setError("")
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
  async function run(operation: "confirm" | "cancel", item: GmailInvocation) {
    setBusy(true)
    setError("")
    try {
      await gmailCommand(workspaceId, operation, {
        id: item.id,
        hash: item.hash,
      })
      setSelected(null)
      const result = await gmailCommand(workspaceId, "list", {
        conversationId,
        context,
      })
      setItems(gmailInvocation.array().parse(result.items))
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Revisa el resultado antes de volver a intentarlo."
      )
    } finally {
      setBusy(false)
    }
  }
  if (!items.length && !error) return null
  return (
    <div className="my-5 space-y-3" aria-label="Acciones de Gmail">
      {items.map((item) => (
        <div
          key={item.id}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-4"
        >
          <div>
            <p className="text-sm font-medium">{gmailLabels[item.operation]}</p>
            <p className="text-xs text-muted-foreground">
              {labels[item.status]} · {item.account}
            </p>
            {item.status === "uncertain" && (
              <p className="mt-2 text-sm text-muted-foreground">
                Comprueba tu buzón antes de solicitar otra acción. No se
                reenviará automáticamente.
              </p>
            )}
          </div>
          {item.status === "pending" && (
            <Button
              variant="outline"
              onClick={() => {
                setSelected(item)
                setConsent(false)
              }}
            >
              Revisar acción
            </Button>
          )}
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Dialog
        open={!!selected}
        onOpenChange={(open) => !busy && !open && setSelected(null)}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {selected ? gmailLabels[selected.operation] : "Revisar acción"}
            </DialogTitle>
            <DialogDescription>
              Confirma esta acción exacta. Cambiar el contenido o los
              destinatarios requiere una nueva confirmación.
            </DialogDescription>
          </DialogHeader>
          {selected && (
            <>
              <Details item={selected} />
              <p className="text-xs text-muted-foreground">
                Válida hasta {formatUtcDateTime(selected.expiresAt)} UTC.
              </p>
              <ConsentCheckbox
                checked={consent}
                onCheckedChange={setConsent}
                disabled={busy}
              >
                Autorizo esta acción en mi cuenta de Gmail.
              </ConsentCheckbox>
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
                    : selected.operation === "gmail.send"
                      ? "Confirmar y enviar"
                      : "Confirmar acción"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
