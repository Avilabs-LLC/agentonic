"use client"
import { useEffect, useState } from "react"
import { ChevronRightIcon, Loader2Icon } from "lucide-react"
import {
  gmailInvocation,
  gmailLabels,
  gmailThreadView,
  gmailWriteMessage,
  type GmailInvocation,
  type GmailThreadView,
} from "@agentonic/contracts/gmail"
import { formatUtcDateTime } from "@agentonic/contracts/format"
import { gmailCommand } from "@workspace/ui/components/gmail-connection"
import { GmailIcon } from "@workspace/ui/components/gmail-icon"
import { Button } from "@workspace/ui/components/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@workspace/ui/components/collapsible"
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@workspace/ui/components/tabs"
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
      {/* One labels proposal covers a batch of messages (§68). */}
      {Array.isArray(args.labels) && (
        <div>
          <dt className="text-muted-foreground">Etiquetas</dt>
          <dd>
            <ul className="space-y-1">
              {(args.labels as { subject: string; label: string }[]).map(
                (l, n) => (
                  <li key={n} className="break-words">
                    {l.subject || "(Sin asunto)"}
                    <span className="text-muted-foreground"> → </span>
                    <span className="font-medium">{l.label}</span>
                  </li>
                )
              )}
            </ul>
            <p className="mt-1 text-xs text-muted-foreground">
              Antes de aplicarlas se comprueba que cada asunto coincide. Las
              etiquetas que falten se crean.
            </p>
          </dd>
        </div>
      )}
      {/* A reply goes in the thread of the message it answers (§67). */}
      {typeof m.replyTo === "string" && (
        <div>
          <dt className="text-muted-foreground">Hilo</dt>
          <dd>Responde en el hilo del correo original</dd>
        </div>
      )}
    </dl>
  )
}
/** The message a draft or send proposes, if the action carries one. */
function proposedMessage(item: GmailInvocation) {
  if (
    !["gmail.drafts.create", "gmail.drafts.update", "gmail.send"].includes(
      item.operation
    )
  )
    return null
  const m = gmailWriteMessage(item.operation, item.arguments) as {
    subject?: unknown
    replyTo?: unknown
    note?: unknown
  } | null
  return m
    ? {
        subject: typeof m.subject === "string" ? m.subject : "",
        replyTo: typeof m.replyTo === "string" ? m.replyTo : null,
        note: typeof m.note === "string" && m.note.trim() ? m.note : null,
      }
    : null
}
const tabPanel = "max-h-[min(28rem,50dvh)] overflow-y-auto pr-1"
/** One message of the conversation a reply answers, as plain text. */
function ThreadMessage({
  message,
}: {
  message: GmailThreadView["messages"][number]
}) {
  const recipients = [
    message.to && `Para: ${message.to}`,
    message.cc && `CC: ${message.cc}`,
  ].filter(Boolean)
  return (
    <Collapsible
      defaultOpen={message.answered}
      className="rounded-lg border data-[open]:bg-muted/20"
    >
      <CollapsibleTrigger className="group flex w-full items-start gap-2 rounded-lg p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon
          className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="font-medium break-all">
              {message.from || "(Sin remitente)"}
            </span>
            <span className="text-xs text-muted-foreground">
              {message.date}
            </span>
          </span>
          {message.answered && (
            <span className="block text-xs text-muted-foreground">
              El mensaje que responde el borrador
            </span>
          )}
          <span className="line-clamp-1 text-xs text-muted-foreground group-data-[panel-open]:hidden">
            {message.text}
          </span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 px-3 pb-3 pl-9">
        {recipients.length > 0 && (
          <p className="text-xs break-all text-muted-foreground">
            {recipients.join(" · ")}
          </p>
        )}
        <p className="text-sm break-words whitespace-pre-wrap">
          {message.text}
        </p>
      </CollapsibleContent>
    </Collapsible>
  )
}
/**
 * The conversation a reply answers (§81), read from Gmail as the card opens.
 * Plain text only: Gmail's HTML, images and attachments are never loaded.
 */
function Conversation({
  workspaceId,
  item,
}: {
  workspaceId: string
  item: GmailInvocation
}) {
  const [thread, setThread] = useState<GmailThreadView | null>(null),
    [failed, setFailed] = useState(false)
  const { id, hash } = item
  useEffect(() => {
    let active = true
    gmailCommand(workspaceId, "thread", { id, hash })
      .then((result) => {
        if (active) setThread(gmailThreadView.parse(result))
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [workspaceId, id, hash])
  if (failed)
    return (
      <p className="text-sm text-muted-foreground">
        No se pudo cargar la conversación desde Gmail. Puedes verla en tu buzón;
        el borrador no cambia.
      </p>
    )
  if (!thread)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
        Cargando la conversación…
      </p>
    )
  if (!thread.messages.length)
    return (
      <p className="text-sm text-muted-foreground">
        Gmail no devolvió el mensaje original. Puede que se haya eliminado.
      </p>
    )
  const subject =
    thread.messages.find((m) => m.answered)?.subject ??
    thread.messages[0]!.subject
  return (
    <div className="space-y-2">
      {subject && <p className="font-medium break-words">{subject}</p>}
      {thread.earlierMessages > 0 && (
        <p className="text-xs text-muted-foreground">
          {thread.earlierMessages === 1
            ? "Hay 1 mensaje anterior que no se muestra."
            : `Hay ${thread.earlierMessages} mensajes anteriores que no se muestran.`}
        </p>
      )}
      {thread.messages.map((m) => (
        <ThreadMessage key={m.id} message={m} />
      ))}
    </div>
  )
}
/**
 * What the owner reviews before confirming (§81): the conversation a reply
 * answers, the proposed message and the agent's note, as tabs when there is
 * more than the action itself to show.
 */
export function GmailReview({
  workspaceId,
  item,
}: {
  workspaceId: string
  item: GmailInvocation
}) {
  const message = proposedMessage(item)
  if (!message?.replyTo && !message?.note) return <Details item={item} />
  return (
    <Tabs
      defaultValue={message.replyTo ? "conversation" : "message"}
      className="gap-3"
    >
      <TabsList className="w-full" aria-label="Contenido de la acción">
        {message.replyTo && (
          <TabsTrigger value="conversation">Conversación</TabsTrigger>
        )}
        <TabsTrigger value="message">
          {item.operation === "gmail.send" ? "Correo" : "Borrador"}
        </TabsTrigger>
        {message.note && <TabsTrigger value="note">Notas</TabsTrigger>}
      </TabsList>
      {message.replyTo && (
        <TabsContent value="conversation" className={tabPanel}>
          <Conversation workspaceId={workspaceId} item={item} />
        </TabsContent>
      )}
      <TabsContent value="message" className={tabPanel}>
        <Details item={item} />
      </TabsContent>
      {message.note && (
        <TabsContent value="note" className={`${tabPanel} space-y-2`}>
          <p className="text-xs text-muted-foreground">
            Escrita por el agente para ti. No forma parte del correo.
          </p>
          <p className="break-words whitespace-pre-wrap">{message.note}</p>
        </TabsContent>
      )}
    </Tabs>
  )
}
async function listInvocations(
  workspaceId: string,
  conversationId: string,
  context: "staging" | "preview"
) {
  const result = await gmailCommand(workspaceId, "list", {
    conversationId,
    context,
  })
  return gmailInvocation.array().parse(result.items)
}
// A pending action past its deadline shows as expired before the server's next
// cleanup records it; the server already refuses to confirm it.
const statusAt = (item: GmailInvocation, at: number) =>
  item.status === "pending" && Date.parse(item.expiresAt) <= at
    ? "expired"
    : item.status
// A dialog left open, for example in another tab, closes once its action is no
// longer pending; its card then shows what happened.
const stillPending = (
  current: GmailInvocation | null,
  next: GmailInvocation[],
  at: number
) =>
  current &&
  next.some(
    (item) => item.id === current.id && statusAt(item, at) === "pending"
  )
    ? current
    : null
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
          setSelected((current) => stillPending(current, next, at))
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
        setSelected((current) => stillPending(current, next, at))
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
    <div className="my-5 space-y-3" aria-label="Acciones de Gmail">
      {items.map((item) => {
        const subject = proposedMessage(item)?.subject
        return (
          <div
            key={item.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-muted/20 p-4"
          >
            <div className="flex min-w-0 flex-1 items-start gap-3">
              <GmailIcon className="mt-0.5 size-6 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {gmailLabels[item.operation]}
                </p>
                {subject && <p className="text-sm break-words">{subject}</p>}
                <p className="text-xs text-muted-foreground">
                  {labels[statusAt(item, now)]} · {item.account}
                </p>
                {item.status === "uncertain" && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    Comprueba tu buzón antes de solicitar otra acción. No se
                    reenviará automáticamente.
                  </p>
                )}
              </div>
            </div>
            {statusAt(item, now) === "pending" && (
              <Button
                variant="outline"
                onClick={() => {
                  setSelected(item)
                  setConsent(false)
                  setError("")
                }}
              >
                Revisar acción
              </Button>
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
        onOpenChange={(open) => !busy && !open && setSelected(null)}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
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
              <GmailReview
                key={selected.id}
                workspaceId={workspaceId}
                item={selected}
              />
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
