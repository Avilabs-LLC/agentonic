"use client"
import { useId, useState } from "react"
import { useRouter } from "next/navigation"
import {
  CheckIcon,
  ClipboardCheckIcon,
  ListChecksIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  XIcon,
  PlusIcon,
  Trash2Icon,
  LoaderCircleIcon,
} from "lucide-react"
import {
  reviewCriteria,
  criterionReviewed,
  type ReviewCriterion,
  type ReviewPreparation,
} from "@agentonic/contracts/review-flow"
import type { FormResult } from "@agentonic/contracts/authoring"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import { Button } from "@workspace/ui/components/button"
import { CriterionStatus } from "@workspace/ui/components/status-badge"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Textarea } from "@workspace/ui/components/textarea"
import { ReviewCriteriaSummary } from "@workspace/ui/components/review-criteria-summary"

type Action = (input: unknown) => Promise<FormResult>
export function shortCriterionBasis(basis: string) {
  const text = basis.replace(/\s+/g, " ").trim()
  if (text.length <= 220) return text
  return `${text.slice(0, 217).replace(/\s+\S*$/, "")}…`
}
export function ReviewCriteriaDialog({
  record,
  action,
  iconOnly = false,
  label = "Revisar situaciones",
  initialOpen = false,
  onClose,
}: {
  record: ReviewPreparation
  action?: Action
  iconOnly?: boolean
  label?: string
  initialOpen?: boolean
  onClose?: () => void
}) {
  const router = useRouter(),
    id = useId()
  const [open, setOpen] = useState(initialOpen),
    [index, setIndex] = useState(
      Math.max(
        0,
        record.criteria.findIndex((c) => !criterionReviewed(c))
      )
    )
  const [criteria, setCriteria] = useState(record.criteria),
    [revision, setRevision] = useState(record.revision)
  const [dirty, setDirty] = useState(false),
    [pending, setPending] = useState(false)
  const [error, setError] = useState(""),
    [closeRequested, setCloseRequested] = useState(false),
    [consent, setConsent] = useState(false)
  const [pendingDecision, setPendingDecision] = useState<
    "approved" | "not_applicable" | null
  >(null)
  const [exclusionOpen, setExclusionOpen] = useState(false)
  const [exclusionReason, setExclusionReason] = useState("")
  const [editingFromSummary, setEditingFromSummary] = useState(false)
  const editable = record.canEdit && !!action
  const current = record.criteria.length ? criteria[index] : undefined
  const reviewed =
    record.status === "criteria_ready"
      ? criteria.filter(criterionReviewed).length
      : criteria.length
  const progress = criteria.length
    ? Math.round((reviewed / criteria.length) * 100)
    : 0
  const ready =
    criteria.length > 0 &&
    reviewed === criteria.length &&
    criteria.some((c) => c.reviewDecision === "approved")
  const allReviewed = criteria.length > 0 && criteria.every(criterionReviewed)
  const summaryMode =
    editable && allReviewed && !editingFromSummary && !!current
  function close() {
    setOpen(false)
    onClose?.()
  }
  function edit(patch: Partial<ReviewCriterion>) {
    setCriteria((items) =>
      items.map((c, i) =>
        i === index ? { ...c, ...patch, reviewDecision: "pending" } : c
      )
    )
    setDirty(true)
    setConsent(false)
    setError("")
  }
  async function save(items: ReviewCriterion[]) {
    const parsed = reviewCriteria.safeParse(items)
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Revisa los campos pendientes."
      )
      return null
    }
    const result = await action!({
      operation: "save",
      payload: { preparationId: record.id, revision, criteria: parsed.data },
    })
    if (!result.ok) {
      setError(result.message)
      return null
    }
    const nextRevision = revision + 1
    setRevision(nextRevision)
    setCriteria(parsed.data)
    setDirty(false)
    setCloseRequested(false)
    router.refresh()
    return nextRevision
  }
  async function decide(decision: "approved" | "not_applicable", reason = "") {
    if (!current || pending || !editable) return
    if (current.reviewDecision === decision) return
    if (decision === "not_applicable" && reason.trim().length < 5) {
      setError("Explica por qué no aplica con al menos 5 caracteres.")
      return
    }
    if (decision === "approved" && current.expectedAnswer.trim().length < 10) {
      setError(
        "Completa la respuesta o el comportamiento esperado antes de aprobar."
      )
      return
    }
    const items = criteria.map((c, i) =>
      i === index
        ? {
            ...c,
            reviewDecision: decision,
            excluded: decision === "not_applicable",
            exclusionReason: decision === "not_applicable" ? reason.trim() : "",
            needsInput: decision === "approved" ? false : c.needsInput,
          }
        : c
    )
    setPendingDecision(decision)
    setPending(true)
    setError("")
    try {
      if ((await save(items)) !== null) {
        setExclusionOpen(false)
        setEditingFromSummary(false)
        setConsent(false)
        if (index < items.length - 1) setIndex(index + 1)
      }
    } catch {
      setError("No se pudo guardar. Tus cambios siguen aquí.")
    } finally {
      setPendingDecision(null)
      setPending(false)
    }
  }
  async function confirm() {
    if (!ready || !consent || pending || !editable) return
    setPending(true)
    setError("")
    try {
      const latestRevision = dirty ? await save(criteria) : revision
      if (latestRevision === null) return
      const result = await action!({
        operation: "confirm",
        payload: {
          preparationId: record.id,
          revision: latestRevision,
          consent: true,
        },
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setDirty(false)
      close()
      router.refresh()
    } catch {
      setError(
        "No se pudo iniciar la evaluación. Revisa el estado antes de volver a intentarlo."
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return
        if (!next && dirty) {
          setCloseRequested(true)
          return
        }
        if (next) {
          setEditingFromSummary(false)
          setCriteria(record.criteria)
          setRevision(record.revision)
          setDirty(false)
          setConsent(false)
          setError("")
          setCloseRequested(false)
          setIndex(
            Math.max(
              0,
              record.criteria.findIndex((c) => !criterionReviewed(c))
            )
          )
        }
        if (next) setOpen(true)
        else close()
      }}
    >
      {!initialOpen && (
        <DialogTrigger
          render={
            <Button
              type="button"
              variant={iconOnly ? "ghost" : "outline"}
              size={iconOnly ? "icon-sm" : "default"}
              aria-label={label}
              disabled={!record.criteria.length}
            />
          }
        >
          <ClipboardCheckIcon aria-hidden="true" />
          {!iconOnly && label}
        </DialogTrigger>
      )}
      <DialogContent
        className="flex max-w-3xl flex-col gap-4 overflow-hidden"
        showCloseButton={!pending}
      >
        {summaryMode ? (
          <ReviewCriteriaSummary
            record={record}
            criteria={criteria}
            consent={consent}
            onConsent={setConsent}
            pending={pending}
            canConfirm={ready}
            onConfirm={() => void confirm()}
            onReview={(nextIndex) => {
              setIndex(nextIndex)
              setEditingFromSummary(true)
              setConsent(false)
              setError("")
            }}
          />
        ) : (
          <div className="space-y-2">
            <DialogTitle>Revisión de las situaciones ({progress}%)</DialogTitle>
            <DialogDescription>
              {editable
                ? "Revisa cada situación y guarda tu decisión. Las pruebas comenzarán cuando confirmes el conjunto."
                : "Consulta los criterios y las decisiones guardadas por el cliente."}
            </DialogDescription>
          </div>
        )}
        {!current && (
          <p className="text-sm text-muted-foreground">
            Esta revisión ya no está disponible.
          </p>
        )}
        {current && !summaryMode && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-4">
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium">
                  Situación {index + 1} de {criteria.length}
                </span>
                <CriterionStatus
                  criterion={current}
                  confirmed={record.status !== "criteria_ready"}
                />
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={index === 0 || pending}
                  onClick={() => {
                    setIndex(index - 1)
                    setError("")
                  }}
                >
                  <ChevronLeftIcon />
                  Anterior
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  disabled={index === criteria.length - 1 || pending}
                  onClick={() => {
                    setIndex(index + 1)
                    setError("")
                  }}
                >
                  Siguiente
                  <ChevronRightIcon />
                </Button>
              </div>
            </div>
            <div
              key={current.key}
              className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1"
            >
              <fieldset disabled={pending || !editable} className="grid gap-4">
                <div className="rounded-lg border bg-muted/20 p-4">
                  <Field>
                    <FieldLabel htmlFor={`${id}-question`}>
                      Mensaje al agente
                    </FieldLabel>
                    <Textarea
                      id={`${id}-question`}
                      className="min-h-20 bg-background"
                      maxLength={1000}
                      value={current.question}
                      onChange={(e) => edit({ question: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="rounded-lg border bg-muted/20 p-4">
                  <Field>
                    <FieldLabel htmlFor={`${id}-answer`}>
                      Respuesta o comportamiento esperado
                    </FieldLabel>
                    <Textarea
                      id={`${id}-answer`}
                      className="min-h-24 bg-background"
                      maxLength={2000}
                      value={current.expectedAnswer}
                      placeholder="Describe qué debería responder o hacer el agente."
                      onChange={(e) =>
                        edit({
                          expectedAnswer: e.target.value,
                          needsInput: false,
                        })
                      }
                    />
                  </Field>
                </div>
              </fieldset>
              <div className="space-y-2 text-sm">
                <p className="text-muted-foreground">
                  <span className="font-medium text-foreground">Motivo: </span>
                  {shortCriterionBasis(current.basis)}
                </p>
                <Dialog>
                  <DialogTrigger
                    render={
                      <Button
                        type="button"
                        variant="link"
                        className="h-auto p-0"
                      />
                    }
                  >
                    Ver fundamento y fuentes
                  </DialogTrigger>
                  <DialogContent className="max-w-xl">
                    <div className="space-y-2">
                      <DialogTitle>Fundamento de la situación</DialogTitle>
                      <DialogDescription>
                        Información utilizada para proponer este criterio.
                      </DialogDescription>
                    </div>
                    <div className="max-h-80 space-y-4 overflow-y-auto text-sm leading-relaxed">
                      <p className="break-words">
                        {current.basis.replace(/\s+/g, " ").trim()}
                      </p>
                      {record.sources
                        .filter((s) => current.sourceIds.includes(s.id))
                        .map((s, n) => (
                          <div
                            key={s.id}
                            className="space-y-2 rounded-lg border p-4"
                          >
                            <h3 className="font-medium">Fuente {n + 1}</h3>
                            <p className="break-words whitespace-pre-wrap text-muted-foreground">
                              {s.text}
                            </p>
                          </div>
                        ))}
                    </div>
                  </DialogContent>
                </Dialog>
              </div>
              <fieldset disabled={pending || !editable} className="space-y-4">
                <Field>
                  <FieldLabel htmlFor={`${id}-notes`}>
                    Aclaraciones (opcional)
                  </FieldLabel>
                  <Textarea
                    id={`${id}-notes`}
                    className="min-h-16"
                    maxLength={1500}
                    value={current.notes}
                    onChange={(e) => edit({ notes: e.target.value })}
                  />
                </Field>
                {current.excluded && (
                  <Field>
                    <FieldLabel htmlFor={`${id}-saved-exclusion`}>
                      Motivo de exclusión
                    </FieldLabel>
                    <Textarea
                      id={`${id}-saved-exclusion`}
                      className="min-h-16 resize-none bg-muted/50 text-muted-foreground"
                      value={current.exclusionReason}
                      readOnly
                    />
                  </Field>
                )}
              </fieldset>
            </div>
            {editable &&
              current.basis === "Aportado por el cliente." &&
              current.sourceIds.length === 0 && (
                <div className="flex flex-wrap gap-3">
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      const items = criteria.filter(
                        (c) => c.key !== current.key
                      )
                      setCriteria(items)
                      setIndex(Math.min(index, items.length - 1))
                      setDirty(true)
                      setConsent(false)
                      setError("")
                    }}
                  >
                    <Trash2Icon />
                    Descartar situación
                  </Button>
                </div>
              )}
          </>
        )}
        {error && !exclusionOpen && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {closeRequested && (
          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm">
              Tienes cambios sin guardar. Aprueba la situación o guarda los
              cambios para continuar después.
            </p>
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                disabled={pending}
                onClick={async () => {
                  setPending(true)
                  try {
                    if ((await save(criteria)) !== null) close()
                  } catch {
                    setError("No se pudo guardar.")
                  } finally {
                    setPending(false)
                  }
                }}
              >
                {pending && (
                  <LoaderCircleIcon
                    className="animate-spin"
                    aria-hidden="true"
                  />
                )}
                Guardar y cerrar
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={() => {
                  setDirty(false)
                  close()
                }}
              >
                Descartar cambios y cerrar
              </Button>
            </div>
          </div>
        )}
        {current && !summaryMode && editable && (
          <div className="-mx-6 -mb-6 grid shrink-0 grid-cols-1 items-center gap-3 border-t bg-popover px-6 py-4 sm:grid-cols-[minmax(0,1fr)_auto]">
            {editable && allReviewed && (
              <Button
                type="button"
                variant="outline"
                className="justify-self-start"
                disabled={pending}
                onClick={() => {
                  setEditingFromSummary(false)
                  setError("")
                }}
              >
                <ListChecksIcon aria-hidden="true" />
                Ver resumen
              </Button>
            )}
            {editable && (
              <div className="flex flex-wrap justify-end gap-2 sm:col-start-2">
                <Button
                  type="button"
                  disabled={pending || current.reviewDecision === "approved"}
                  aria-busy={pendingDecision === "approved"}
                  onClick={() => void decide("approved")}
                >
                  {pendingDecision === "approved" ? (
                    <LoaderCircleIcon
                      className="animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <CheckIcon />
                  )}
                  Aprobar situación
                </Button>
                <Dialog
                  open={exclusionOpen}
                  onOpenChange={(next) => {
                    if (pending) return
                    if (next) {
                      setExclusionReason(current.exclusionReason)
                      setError("")
                    } else setError("")
                    setExclusionOpen(next)
                  }}
                >
                  <DialogTrigger
                    render={
                      <Button
                        type="button"
                        disabled={
                          pending || current.reviewDecision === "not_applicable"
                        }
                        variant="outline"
                        aria-busy={pendingDecision === "not_applicable"}
                      />
                    }
                  >
                    {pendingDecision === "not_applicable" ? (
                      <LoaderCircleIcon
                        className="animate-spin"
                        aria-hidden="true"
                      />
                    ) : (
                      <XIcon />
                    )}
                    No aplica
                  </DialogTrigger>
                  <DialogContent
                    className="max-w-lg"
                    showCloseButton={!pending}
                  >
                    <div className="space-y-2">
                      <DialogTitle>
                        ¿Por qué no aplica esta situación?
                      </DialogTitle>
                      <DialogDescription>
                        Explica el motivo para que el equipo pueda revisar la
                        exclusión.
                      </DialogDescription>
                    </div>
                    <form
                      className="space-y-4"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void decide("not_applicable", exclusionReason)
                      }}
                    >
                      <Field>
                        <FieldLabel htmlFor={`${id}-exclusion-reason`}>
                          Motivo
                        </FieldLabel>
                        <Textarea
                          id={`${id}-exclusion-reason`}
                          value={exclusionReason}
                          disabled={pending}
                          minLength={5}
                          maxLength={500}
                          required
                          onChange={(event) => {
                            setExclusionReason(event.target.value)
                            setError("")
                          }}
                          placeholder="Describe por qué esta situación no corresponde a tu agente."
                        />
                      </Field>
                      {error && (
                        <p role="alert" className="text-sm text-destructive">
                          {error}
                        </p>
                      )}
                      <div className="flex justify-end gap-3">
                        <Button
                          type="button"
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            setExclusionOpen(false)
                            setError("")
                          }}
                        >
                          Cancelar
                        </Button>
                        <Button
                          type="submit"
                          disabled={
                            pending || exclusionReason.trim().length < 5
                          }
                          aria-busy={pendingDecision === "not_applicable"}
                        >
                          {pendingDecision === "not_applicable" ? (
                            <LoaderCircleIcon
                              className="animate-spin"
                              aria-hidden="true"
                            />
                          ) : (
                            <CheckIcon />
                          )}
                          Confirmar
                        </Button>
                      </div>
                    </form>
                  </DialogContent>
                </Dialog>
              </div>
            )}
          </div>
        )}
        {summaryMode && (
          <div className="-mx-6 -mb-6 flex shrink-0 justify-end border-t border-slate-200 bg-slate-100 px-6 py-4 dark:border-slate-700/60 dark:bg-slate-800/60">
            <Button
              type="button"
              variant="ghost"
              disabled={pending || criteria.length >= 12}
              onClick={() => {
                setCriteria([
                  ...criteria,
                  {
                    key: `case-${crypto.randomUUID().slice(0, 8)}`,
                    question: "",
                    expectedAnswer: "",
                    basis: "Aportado por el cliente.",
                    sourceIds: [],
                    needsInput: false,
                    notes: "",
                    excluded: false,
                    exclusionReason: "",
                    reviewDecision: "pending",
                  },
                ])
                setIndex(criteria.length)
                setDirty(true)
                setConsent(false)
                setError("")
              }}
            >
              <PlusIcon />
              Agregar situación
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
