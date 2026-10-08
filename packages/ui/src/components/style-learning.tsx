"use client"
// Aprender mi estilo (architecture §57): in each Gmail account's frame, the
// person who connected it can have the knowledge worker read the mail they sent
// and draft a writing-style guide, then review it before it joins Conocimiento.
// Progress comes from the database's observed state, polled while it runs.
import { useCallback, useEffect, useRef, useState } from "react"
import { Checkbox } from "@base-ui/react/checkbox"
import {
  CircleCheckBigIcon,
  CircleCheckIcon,
  CircleIcon,
  Clock3Icon,
  Loader2Icon,
  SparklesIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import {
  STYLE_BUDGET,
  STYLE_MAX_MESSAGES,
  STYLE_WINDOW_DAYS,
  activeStyleStatuses,
  styleCommandErrors,
  styleErrors,
  styleGuideState,
  type StyleGuide,
} from "@agentonic/contracts/style-guide"
import { Button } from "@workspace/ui/components/button"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import { ConsentCheckbox } from "@workspace/ui/components/consent-checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Textarea } from "@workspace/ui/components/textarea"
import { iconTones } from "@workspace/ui/components/status-badge"
import { statusDescriptor } from "@workspace/ui/lib/badge-status"
import { notify } from "@workspace/ui/lib/toast"
import { cn } from "cn"

async function styleCommand(
  workspace: string,
  operation: string,
  payload: Record<string, unknown>
) {
  const response = await fetch(`/api/style?workspace=${workspace}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operation, payload }),
    cache: "no-store",
  })
  const result = (await response.json()) as Record<string, unknown>
  if (!response.ok)
    throw new Error(String(result.error ?? "No se pudo completar la acción."))
  if (result.ok === false)
    throw new Error(
      styleCommandErrors[String(result.code)] ??
        "No se pudo completar la acción."
    )
  return result
}
const money = new Intl.NumberFormat("es-VE", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
const day = new Intl.DateTimeFormat("es-VE", { dateStyle: "medium" })
const number = new Intl.NumberFormat("es-VE")

type Step = { label: string; detail?: string }
/** The four steps, and which one the observed state is on. */
function steps(guide: StyleGuide): { list: Step[]; current: number } {
  const read =
    guide.messagesTotal === null
      ? undefined
      : `${number.format(guide.messagesRead)} de ${number.format(guide.messagesTotal)}`
  const analyzed =
    guide.batchesTotal === null
      ? undefined
      : `Lote ${number.format(Math.min(guide.batchesDone + 1, guide.batchesTotal))} de ${number.format(guide.batchesTotal)}`
  const list: Step[] = [
    { label: "Leer tus correos enviados", detail: read },
    {
      label: "Analizar tu estilo",
      detail:
        guide.status === "analyzing"
          ? analyzed
          : guide.messagesUsed !== null
            ? `${number.format(guide.messagesUsed)} correos escritos por ti`
            : undefined,
    },
    { label: "Redactar la guía" },
    { label: "Revisar y agregar a Conocimiento" },
  ]
  const current = {
    queued: 0,
    reading: 0,
    analyzing: 1,
    writing: 2,
    ready: 3,
  }[guide.status as string]
  return { list, current: current ?? 4 }
}

export function StyleLearning({
  workspaceId,
  agentId,
  connection,
  initial,
  collections,
  agentCollectionIds,
  disabled,
  onAccepted = () => {},
}: {
  workspaceId: string
  agentId: string
  connection: { id: string; account: string }
  initial?: StyleGuide
  collections: { id: string; name: string }[]
  agentCollectionIds: string[]
  disabled: boolean
  /** The page refreshes its documents once a guide joins a collection. */
  onAccepted?: () => void
}) {
  const [guide, setGuide] = useState(initial)
  const [starting, setStarting] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [pending, setPending] = useState(false)
  const active = !!guide && activeStyleStatuses.includes(guide.status)
  const previous = useRef(guide?.status)

  const refresh = useCallback(async () => {
    const result = await styleCommand(workspaceId, "state", { agentId })
    const next = styleGuideState
      .parse(result)
      .guides.find((g) => g.connectionId === connection.id)
    setGuide(next)
    return next
  }, [workspaceId, agentId, connection.id])

  // Poll only while the run is queued or in progress.
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => void refresh().catch(() => {}), 3000)
    return () => clearInterval(timer)
  }, [active, refresh])
  useEffect(() => {
    const was = previous.current
    previous.current = guide?.status
    if (!was || !activeStyleStatuses.includes(was)) return
    if (guide?.status === "ready")
      notify.success("Tu guía de estilo está lista para revisar.")
    else if (guide?.status === "failed")
      notify.destructive("El aprendizaje de estilo no se pudo completar.")
  }, [guide?.status])

  async function act(operation: string, payload: Record<string, unknown>) {
    setPending(true)
    try {
      await styleCommand(workspaceId, operation, payload)
      await refresh()
      return true
    } catch (e) {
      notify.destructive(
        e instanceof Error ? e.message : "No se pudo completar la acción."
      )
      return false
    } finally {
      setPending(false)
    }
  }

  const status = guide?.status
  const idle =
    !guide ||
    status === "discarded" ||
    status === "cancelled" ||
    status === "failed"
  return (
    <div className="rounded-lg border border-dashed border-primary/40 bg-primary/5 p-3">
      {idle ? (
        <>
          <label className="flex cursor-pointer items-start gap-3">
            {/* A round box: one action to run, not a permission like the tools above. */}
            <Checkbox.Root
              checked={false}
              disabled={disabled || pending}
              onCheckedChange={() => setStarting(true)}
              aria-describedby={`style-${connection.id}-help`}
              className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border border-primary/60 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="space-y-1">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <SparklesIcon
                  className="size-4 text-primary"
                  aria-hidden="true"
                />
                Aprender mi estilo de escritura
              </span>
              <span
                id={`style-${connection.id}-help`}
                className="block text-sm text-muted-foreground"
              >
                Analiza los correos que escribiste en los últimos{" "}
                {STYLE_WINDOW_DAYS} días y prepara una guía para que el agente
                redacte como tú. La revisas antes de agregarla a Conocimiento.
              </span>
            </span>
          </label>
          {status === "failed" && (
            <p className="mt-3 flex items-start gap-1.5 text-sm">
              <XIcon
                className={cn("mt-0.5 size-4 shrink-0", iconTones.error)}
                aria-hidden="true"
              />
              <span>
                {styleErrors[guide?.errorCode ?? ""] ?? styleErrors.lease_lost}
              </span>
            </p>
          )}
        </>
      ) : status === "accepted" ? (
        <div className="flex items-start gap-3">
          <CircleCheckBigIcon
            className={cn(
              "size-6 shrink-0 animate-in duration-500 zoom-in-50 fade-in motion-reduce:animate-none",
              iconTones.success
            )}
            aria-hidden="true"
          />
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium">
              {statusDescriptor("styleGuide", "accepted").label}
            </p>
            <p className="text-sm text-muted-foreground">
              {guide?.document
                ? `«${guide.document.title}» está en la colección ${guide.document.collection}. `
                : ""}
              Se usará desde la próxima versión: prepara una nueva versión para
              incluirla.
            </p>
            <Button
              type="button"
              variant="link"
              className="h-auto p-0"
              disabled={disabled || pending}
              onClick={() => setStarting(true)}
            >
              Volver a aprender
            </Button>
          </div>
        </div>
      ) : (
        <Progress
          guide={guide!}
          pending={pending}
          disabled={disabled}
          onCancel={() => void act("cancel", { id: guide!.id })}
          onReview={() => setReviewing(true)}
        />
      )}
      <StartDialog
        open={starting}
        onOpenChange={setStarting}
        account={connection.account}
        pending={pending}
        onStart={async (budgetUsd) => {
          const ok = await act("start", {
            agentId,
            connectionId: connection.id,
            budgetUsd,
            consent: true,
            requestId: crypto.randomUUID(),
          })
          if (ok) {
            setStarting(false)
            notify.success(
              "Aprendizaje en cola. Puedes cerrar esta página; seguirá en segundo plano."
            )
          }
        }}
      />
      {guide?.status === "ready" && guide.guide !== null && (
        <ReviewDialog
          open={reviewing}
          onOpenChange={setReviewing}
          guide={guide}
          collections={collections}
          agentCollectionIds={agentCollectionIds}
          pending={pending}
          onDiscard={async () => {
            if (await act("discard", { id: guide.id })) {
              setReviewing(false)
              notify.success("Guía descartada.")
            }
          }}
          onAccept={async (collectionId, markdown) => {
            if (await act("accept", { id: guide.id, collectionId, markdown })) {
              setReviewing(false)
              notify.success("Guía agregada a Conocimiento.")
              onAccepted()
            }
          }}
        />
      )}
    </div>
  )
}

function Progress({
  guide,
  pending,
  disabled,
  onCancel,
  onReview,
}: {
  guide: StyleGuide
  pending: boolean
  disabled: boolean
  onCancel: () => void
  onReview: () => void
}) {
  const { list, current } = steps(guide)
  const queued = guide.status === "queued"
  const ready = guide.status === "ready"
  const descriptor = statusDescriptor("styleGuide", guide.status)
  // A determinate bar only for steps with real counts.
  const fraction =
    guide.status === "reading" && guide.messagesTotal
      ? guide.messagesRead / guide.messagesTotal
      : guide.status === "analyzing" && guide.batchesTotal
        ? guide.batchesDone / guide.batchesTotal
        : null
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          <SparklesIcon className="size-4 text-primary" aria-hidden="true" />
          {ready ? "Tu guía de estilo está lista" : "Aprendiendo tu estilo"}
        </p>
        <span
          className={cn(
            "flex items-center gap-1.5 text-xs",
            iconTones[descriptor.variant]
          )}
          aria-live="polite"
        >
          {descriptor.label}
        </span>
      </div>
      <ol className="space-y-2">
        {list.map((step, index) => {
          const done = index < current
          const now = index === current
          const Icon = done
            ? CircleCheckIcon
            : now
              ? queued
                ? Clock3Icon
                : ready
                  ? TriangleAlertIcon
                  : Loader2Icon
              : CircleIcon
          return (
            <li key={step.label} className="flex items-start gap-2.5 text-sm">
              <Icon
                aria-hidden="true"
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  done
                    ? iconTones.success
                    : now
                      ? queued || ready
                        ? iconTones.warning
                        : cn(
                            iconTones.sky,
                            "animate-spin motion-reduce:animate-none"
                          )
                      : "text-muted-foreground/50"
                )}
              />
              <span className={cn(!done && !now && "text-muted-foreground")}>
                {step.label}
                {step.detail && (
                  <span className="text-muted-foreground tabular-nums">
                    {" · "}
                    {step.detail}
                  </span>
                )}
                <span className="sr-only">
                  {done ? " (completado)" : now ? " (en curso)" : ""}
                </span>
              </span>
            </li>
          )
        })}
      </ol>
      {fraction !== null && (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-label={list[current]?.label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fraction * 100)}
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
            style={{ width: `${Math.max(2, fraction * 100)}%` }}
          />
        </div>
      )}
      {ready ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            size="sm"
            disabled={disabled || pending}
            onClick={onReview}
          >
            Revisar guía
          </Button>
          <span className="text-xs text-muted-foreground">
            Uso {money.format(guide.committedMicrousd / 1000000)}
            {guide.expiresAt &&
              ` · Si no decides, se elimina el ${day.format(new Date(guide.expiresAt))}`}
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            {queued
              ? "Empezará en cuanto haya un turno libre."
              : "Puedes cerrar esta página: sigue en segundo plano y suele tardar unos minutos."}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || pending}
            onClick={onCancel}
          >
            Cancelar
          </Button>
        </div>
      )}
    </div>
  )
}

function StartDialog({
  open,
  onOpenChange,
  account,
  pending,
  onStart,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  account: string
  pending: boolean
  onStart: (budgetUsd: number) => void
}) {
  const [consent, setConsent] = useState(false)
  const [budget, setBudget] = useState(String(STYLE_BUDGET.default))
  const value = Number(budget)
  const valid =
    consent &&
    Number.isFinite(value) &&
    value >= STYLE_BUDGET.min &&
    value <= STYLE_BUDGET.max
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setConsent(false)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Aprender tu estilo de escritura</DialogTitle>
          <DialogDescription>
            Agentonic leerá los correos que enviaste desde {account} para
            describir cómo escribes.
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 text-sm">
          {[
            `Solo lee correos que tú enviaste en los últimos ${STYLE_WINDOW_DAYS} días, hasta ${STYLE_MAX_MESSAGES}. Omite reenvíos, respuestas automáticas y el texto citado de otras personas.`,
            "Los correos se analizan con OpenAI y no se guardan: Agentonic solo conserva la guía resultante.",
            "La guía describe tu estilo, no el contenido: sin nombres, direcciones ni frases copiadas de tus correos.",
            "Tú la revisas y decides si agregarla a Conocimiento. Si no decides en 7 días, se elimina.",
          ].map((item) => (
            <li key={item} className="flex items-start gap-2">
              <CircleCheckIcon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span>{item}</span>
            </li>
          ))}
        </ul>
        <Field>
          <FieldLabel htmlFor="style-budget">Límite de gasto (USD)</FieldLabel>
          <Input
            id="style-budget"
            type="number"
            min={STYLE_BUDGET.min}
            max={STYLE_BUDGET.max}
            step="0.05"
            className="max-w-40"
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
          />
          <FieldDescription>
            Se cobra según el texto analizado y se detiene si alcanza este
            límite. Entre {money.format(STYLE_BUDGET.min)} y{" "}
            {money.format(STYLE_BUDGET.max)}.
          </FieldDescription>
        </Field>
        <ConsentCheckbox checked={consent} onCheckedChange={setConsent}>
          Autorizo a Agentonic a leer los correos que envié desde esta cuenta
          para preparar esta guía.
        </ConsentCheckbox>
        <div className="flex justify-end gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancelar
          </Button>
          <Button
            type="button"
            disabled={!valid || pending}
            onClick={() => onStart(value)}
          >
            {pending ? "Poniendo en cola…" : "Aprender mi estilo"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ReviewDialog({
  open,
  onOpenChange,
  guide,
  collections,
  agentCollectionIds,
  pending,
  onDiscard,
  onAccept,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  guide: StyleGuide
  collections: { id: string; name: string }[]
  agentCollectionIds: string[]
  pending: boolean
  onDiscard: () => void
  onAccept: (collectionId: string, markdown: string) => void
}) {
  const [markdown, setMarkdown] = useState(guide.guide ?? "")
  const [collectionId, setCollectionId] = useState(
    collections.find((c) => agentCollectionIds.includes(c.id))?.id ??
      collections[0]?.id ??
      ""
  )
  const [discarding, setDiscarding] = useState(false)
  const outside = !!collectionId && !agentCollectionIds.includes(collectionId)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Tu guía de estilo</DialogTitle>
          <DialogDescription>
            Revísala y quita lo que no quieras compartir. Se agregará como
            documento a la colección que elijas, y quienes puedan leer esa
            colección la verán.
          </DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel htmlFor="style-guide-text">Guía (Markdown)</FieldLabel>
          <Textarea
            id="style-guide-text"
            className="min-h-80 font-mono text-xs"
            maxLength={40000}
            value={markdown}
            onChange={(e) => setMarkdown(e.target.value)}
          />
        </Field>
        {collections.length ? (
          <Field>
            <FieldLabel>Colección</FieldLabel>
            <Select
              items={collections.map((c) => ({ value: c.id, label: c.name }))}
              value={collectionId}
              onValueChange={(value) => {
                if ((value ?? "") !== collectionId) setCollectionId(value ?? "")
              }}
            >
              <SelectTrigger aria-label="Colección para la guía">
                <SelectValue placeholder="Elige una colección" />
              </SelectTrigger>
              <SelectContent className="w-auto max-w-(--available-width) min-w-(--anchor-width)">
                {collections.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {outside && (
              <FieldDescription>
                Esta colección no está seleccionada para el agente. Selecciónala
                en Conocimiento solicitado para que el agente use la guía.
              </FieldDescription>
            )}
          </Field>
        ) : (
          <CardEmptyState title="Sin colecciones disponibles">
            Crea una colección en Conocimiento para poder agregar la guía.
          </CardEmptyState>
        )}
        {discarding ? (
          <div className="flex flex-wrap items-center justify-end gap-3">
            <p className="mr-auto text-sm">
              La guía se eliminará y no podrás recuperarla.
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDiscarding(false)}
            >
              Volver
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={onDiscard}
            >
              Descartar guía
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-3">
            <Button
              type="button"
              variant="outline"
              className="mr-auto"
              disabled={pending}
              onClick={() => setDiscarding(true)}
            >
              Descartar
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              disabled={pending || !collectionId || !markdown.trim().length}
              onClick={() => onAccept(collectionId, markdown)}
            >
              {pending ? "Agregando…" : "Agregar a Conocimiento"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
