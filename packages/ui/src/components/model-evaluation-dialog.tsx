"use client"
import { useEffect, useRef, useState } from "react"
import { useRouter } from "next/navigation"
import { LoaderCircleIcon, CheckIcon } from "lucide-react"
import {
  batchPassed,
  batchModelGroups,
  batchRunning,
  type EvaluationBatch,
  type ReviewPreparation,
} from "@agentonic/contracts/review-flow"
import { formatUsd } from "@agentonic/contracts/format"
import {
  evaluationModels,
  OLD_RUNTIME_MODELS_NOTE,
  selectableModelsFor,
  modelConfigurationKey,
  modelConfigurationLabel,
  reasoningLabels,
  suggestedEvaluationBudget,
  type ModelConfiguration,
} from "@agentonic/contracts/models"
import type { FormResult } from "@agentonic/contracts/authoring"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { useEdgeFade } from "@workspace/ui/components/tabs"
import { Checkbox } from "@base-ui/react/checkbox"
import {
  Field,
  FieldDescription,
  FieldLabel,
} from "@workspace/ui/components/field"
import { ConsentCheckbox } from "@workspace/ui/components/consent-checkbox"
import {
  Table,
  TableHeader,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
} from "@workspace/ui/components/table"
import { ReceiptResults } from "@workspace/ui/components/review-receipt-content"
import { ProposalDialogHeader } from "@workspace/ui/components/proposal-dialog-header"
import { ReviewResultStatus } from "@workspace/ui/components/review-result-status"
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@workspace/ui/components/select"

export function modelResultsLabel(record: ReviewPreparation) {
  const batch = record.batches[0]
  if (!batch) return "Sin evaluar"
  if (batchRunning(batch))
    return `Evaluando · ${batchModelGroups(batch).filter((m) => !["queued", "running"].includes(m.status)).length}/${batchModelGroups(batch).length}`
  return `${batchPassed(batch)}/${batchModelGroups(batch).length} modelos al 100 %`
}
/** One model and level's result in the summary: passed only when it ran
 * every situation and passed them all. */
function configurationOutcome(m: EvaluationBatch["models"][number]): {
  outcome: "passed" | "failed" | "pending" | "attention"
  label: string
} {
  if (m.status === "running") return { outcome: "pending", label: "Evaluando" }
  if (["queued", "awaiting_consent"].includes(m.status))
    return { outcome: "pending", label: "En cola" }
  if (m.status === "passed" && m.total > 0 && m.passed === m.total)
    return { outcome: "passed", label: "100 %" }
  if (["error", "cancelled"].includes(m.status))
    return { outcome: "attention", label: "Interrumpida" }
  return { outcome: "failed", label: "Con fallos" }
}

/** The evaluated models as chips in one row that scrolls sideways. */
function ModelChips({
  models,
  selected,
  onSelect,
}: {
  models: string[]
  selected: string
  onSelect: (model: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const fade = useEdgeFade(ref)
  return (
    <div ref={ref} className="min-w-0 flex-1 overflow-x-auto" style={fade}>
      <div
        role="group"
        aria-label="Modelos evaluados"
        className="flex w-max gap-2 py-0.5"
      >
        {models.map((id) => (
          <Button
            key={id}
            size="sm"
            variant={id === selected ? "secondary" : "outline"}
            aria-pressed={id === selected}
            className="rounded-full"
            onClick={() => onSelect(id)}
          >
            {modelConfigurationLabel({ model: id, reasoning: null })}
          </Button>
        ))}
      </div>
    </div>
  )
}

export function ModelResultsDialog({
  record,
  open,
  onClose,
  initialBatchId,
}: {
  record: Pick<
    ReviewPreparation,
    "batches" | "revision" | "versionNumber" | "agentName"
  > & {
    committedMicrousd?: number
  }
  open: boolean
  initialBatchId?: string
  onClose: () => void
}) {
  const [selectedBatch, setSelectedBatch] = useState<string | null>(
    initialBatchId ?? null
  )
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const batch =
    record.batches.find((b) => b.id === selectedBatch) ?? record.batches[0]
  const model =
    batch && batchModelGroups(batch).find((m) => m.model === selectedModel)
  const completed = batch?.models.reduce((sum, m) => sum + m.completed, 0) ?? 0
  const total = batch?.models.reduce((sum, m) => sum + m.total, 0) ?? 0
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="max-w-4xl gap-6">
        <ProposalDialogHeader
          section="Resultados"
          agentName={record.agentName}
          version={record.versionNumber}
          criteriaRevision={batch?.revision ?? record.revision}
        />
        {!batch ? (
          <p className="text-sm text-muted-foreground">
            Los resultados aparecerán cuando inicies una evaluación.
          </p>
        ) : (
          <>
            {record.batches.length > 1 && (
              <Select
                value={batch.id}
                items={record.batches.map((b, i) => ({
                  value: b.id,
                  label: `Ejecución ${record.batches.length - i}${i === 0 ? " · Más reciente" : ""}`,
                }))}
                onValueChange={(value) => {
                  // Pressing the run already shown keeps the chosen model.
                  if (value === batch.id) return
                  setSelectedBatch(value)
                  setSelectedModel(null)
                }}
              >
                <SelectTrigger
                  className="w-full"
                  aria-label="Ejecución de evaluación"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {record.batches.map((b, i) => (
                    <SelectItem key={b.id} value={b.id}>
                      Ejecución {record.batches.length - i}
                      {i === 0 ? " · Más reciente" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <div className="space-y-2" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2">
                  {batchRunning(batch) && (
                    <LoaderCircleIcon className="size-4 animate-spin" />
                  )}{" "}
                  {completed}/{total} pruebas completadas
                </span>
                <span className="text-muted-foreground">
                  {formatUsd(
                    batch.models.reduce(
                      (sum, m) => sum + m.committedMicrousd,
                      0
                    ) / 1000000
                  )}{" "}
                  de {formatUsd(batch.budgetUsd)}
                </span>
              </div>
              <progress
                className="block h-2 w-full appearance-none overflow-hidden rounded-full border-0 bg-muted [&::-moz-progress-bar]:rounded-full [&::-moz-progress-bar]:bg-primary [&::-webkit-progress-bar]:rounded-full [&::-webkit-progress-bar]:bg-muted [&::-webkit-progress-value]:rounded-full [&::-webkit-progress-value]:bg-primary"
                value={completed}
                max={Math.max(total, 1)}
                aria-label="Progreso de evaluación"
              />
            </div>
            {model ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <ModelChips
                    models={batchModelGroups(batch).map((m) => m.model)}
                    selected={model.model}
                    onSelect={setSelectedModel}
                  />
                  <Button
                    className="shrink-0"
                    onClick={() => setSelectedModel(null)}
                  >
                    Ir al resumen
                  </Button>
                </div>
                {model.configurations.map((configuration) => (
                  <section key={configuration.id} className="space-y-3">
                    <p className="text-sm text-muted-foreground">
                      {configuration.reasoning
                        ? `${reasoningLabels[configuration.reasoning as keyof typeof reasoningLabels] ?? configuration.reasoning} · `
                        : ""}
                      {configuration.passed}/{configuration.total} superadas
                    </p>
                    {configuration.errorCode && (
                      <p className="text-sm text-destructive">
                        {configuration.errorCode === "budget_exhausted"
                          ? "Se alcanzó el límite de esta ejecución: cada llamada reserva su costo máximo antes de empezar, así que el límite puede alcanzarse antes que el consumo. Repite la evaluación con un límite mayor."
                          : configuration.errorCode === "provider_unavailable"
                            ? "El proveedor de IA rechazó o no respondió una llamada, así que la evaluación de este nivel se detuvo."
                            : "La evaluación de este modelo se interrumpió."}{" "}
                        Se conserva el consumo realizado.
                      </p>
                    )}
                    {configuration.results.length ? (
                      <ReceiptResults results={configuration.results} />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        Sin respuestas disponibles todavía.
                      </p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Evaluador: {configuration.grader ?? "No registrado"}
                    </p>
                  </section>
                ))}
              </div>
            ) : (
              // One row per model and level, on one line (owner direction,
              // 13 October 2026): each level has its own situations and result.
              <Table aria-label="Resultados por modelo">
                <TableHeader>
                  <TableRow>
                    <TableHead>Modelo</TableHead>
                    <TableHead>Situaciones</TableHead>
                    <TableHead>Resultado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batch.models.map((m) => {
                    const outcome = configurationOutcome(m)
                    return (
                      <TableRow key={m.id}>
                        <TableCell>
                          <Button
                            variant="link"
                            className="h-auto p-0 text-left text-foreground underline underline-offset-4"
                            onClick={() => setSelectedModel(m.model)}
                          >
                            {modelConfigurationLabel(m)}
                          </Button>
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {m.passed}/{m.total} superadas
                        </TableCell>
                        <TableCell>
                          <ReviewResultStatus
                            outcome={outcome.outcome}
                            label={outcome.label}
                          />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            )}
          </>
        )}
        {record.committedMicrousd !== undefined && (
          <p className="text-xs text-muted-foreground">
            Consumo acumulado, incluida la preparación y reservas pendientes:{" "}
            {formatUsd(record.committedMicrousd / 1000000)}.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function RunModelEvaluationDialog({
  record,
  openModels = false,
  action,
  onClose,
  onStarted,
}: {
  record: ReviewPreparation
  /** The version's runtime accepts any offered model (0.8.0, §77). */
  openModels?: boolean
  action: (input: unknown) => Promise<FormResult>
  onClose: () => void
  onStarted: () => void
}) {
  const router = useRouter()
  const offered = selectableModelsFor(openModels)
  const [models, setModels] = useState<ModelConfiguration[]>(() => {
    // The previous run's choices that are still offered for this version,
    // or every offered model at its default level.
    const previous = (
      record.batches[0]?.id !== record.evaluationId
        ? record.batches[0]?.models
        : undefined
    )?.flatMap((m) => {
      const value = evaluationModels.element.safeParse({
        model: m.model,
        reasoning: m.reasoning,
      })
      return value.success && offered.some((o) => o.id === value.data.model)
        ? [value.data]
        : []
    })
    return previous?.length
      ? previous
      : offered.map((m) => ({ model: m.id, reasoning: m.defaultLevel }))
  })
  // The limit follows the selected models until the person edits it (§70).
  const [budget, setBudget] = useState(() =>
    String(suggestedEvaluationBudget(models))
  )
  const [budgetEdited, setBudgetEdited] = useState(false)
  const [consent, setConsent] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  function changed() {
    setConsent(false)
    setError("")
    setRequestId(crypto.randomUUID())
  }
  function toggle(configuration: ModelConfiguration) {
    changed()
    const next = models.some(
      (m) => modelConfigurationKey(m) === modelConfigurationKey(configuration)
    )
      ? models.filter(
          (m) =>
            modelConfigurationKey(m) !== modelConfigurationKey(configuration)
        )
      : [...models, configuration]
    setModels(next)
    if (!budgetEdited) setBudget(String(suggestedEvaluationBudget(next)))
  }
  async function run() {
    if (pending || !consent || !evaluationModels.safeParse(models).success)
      return
    setPending(true)
    setError("")
    try {
      const result = await action({
        operation: "run",
        payload: {
          preparationId: record.id,
          revision: record.revision,
          models,
          budgetUsd: Number(budget),
          consent: true,
          requestId,
        },
      })
      if (!result.ok) {
        setError(result.message)
        return
      }
      router.refresh()
      onStarted()
    } catch {
      setError(
        "No se pudo confirmar el inicio. Revisa Resultados antes de volver a intentarlo."
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="max-w-2xl gap-6" showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>Evaluar modelos</DialogTitle>
          <DialogDescription>
            Elige los modelos y niveles que quieres comparar con los criterios
            confirmados. Cada combinación ejecuta todas las situaciones.
          </DialogDescription>
        </DialogHeader>
        {!openModels && (
          <p className="text-sm text-muted-foreground">
            {OLD_RUNTIME_MODELS_NOTE}
          </p>
        )}
        {/* Compact: levels in three columns of short rows (owner direction,
            2026-10-08), so each model takes one or two rows. */}
        <div className="space-y-3">
          {offered.map((m) => (
            <fieldset key={m.id} disabled={pending} className="border-b pb-3">
              <legend className="mb-1 text-sm font-medium">{m.name}</legend>
              <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
                {(m.levels.length ? m.levels : [null]).map((level) => (
                  <label
                    key={level ?? "default"}
                    className="flex min-h-7 cursor-pointer items-center gap-2.5 text-sm"
                  >
                    <Checkbox.Root
                      className="size-4 shrink-0 rounded-sm border border-input data-checked:bg-primary"
                      checked={models.some(
                        (choice) =>
                          choice.model === m.id && choice.reasoning === level
                      )}
                      onCheckedChange={() =>
                        toggle({ model: m.id, reasoning: level })
                      }
                    >
                      <Checkbox.Indicator>
                        <CheckIcon className="size-3 text-primary-foreground" />
                      </Checkbox.Indicator>
                    </Checkbox.Root>
                    {level ? reasoningLabels[level] : "Incluir"}
                  </label>
                ))}
              </div>
            </fieldset>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          {models.length}{" "}
          {models.length === 1
            ? "combinación seleccionada"
            : "combinaciones seleccionadas"}
          .
        </p>
        <Field>
          <FieldLabel htmlFor="evaluation-budget">
            Límite de esta ejecución (USD)
          </FieldLabel>
          <Input
            id="evaluation-budget"
            type="number"
            min="0.05"
            max="50"
            step="0.05"
            value={budget}
            disabled={pending}
            onChange={(e) => {
              setBudget(e.target.value)
              setBudgetEdited(true)
              changed()
            }}
          />
          <FieldDescription>
            Sugerido para esta selección:{" "}
            {formatUsd(suggestedEvaluationBudget(models))}. Cada llamada reserva
            su costo máximo antes de empezar; solo se cobra lo consumido.
          </FieldDescription>
        </Field>
        <ConsentCheckbox
          checked={consent}
          onCheckedChange={(value) => setConsent(value === true)}
          disabled={pending}
        >
          Autorizo esta ejecución hasta {formatUsd(Number(budget) || 0)}. Cada
          ejecución consume IA y puede generar cargos, incluso si hay fallos.
          Repetirla implica consumo adicional.
        </ConsentCheckbox>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" disabled={pending} onClick={onClose}>
            Volver
          </Button>
          <Button
            disabled={
              pending ||
              !consent ||
              !models.length ||
              Number(budget) < 0.05 ||
              Number(budget) > 50
            }
            onClick={() => void run()}
          >
            {pending && <LoaderCircleIcon className="animate-spin" />}Iniciar
            evaluación
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function ApprovedModelResults({
  batch,
  agentName,
  versionNumber,
  history = [],
  currentRevision,
  totalCommittedMicrousd,
}: {
  batch: ReviewPreparation["batches"][number]
  agentName: string
  versionNumber: number
  history?: ReviewPreparation["batches"]
  currentRevision?: number
  totalCommittedMicrousd?: number
}) {
  const [open, setOpen] = useState(false)
  const router = useRouter()
  const active = history.some(batchRunning)
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), active ? 3000 : 15000)
    return () => clearInterval(timer)
  }, [active, router])
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        {batchPassed(batch)}/{batchModelGroups(batch).length} modelos al 100 % ·
        Ver resultados{active ? " · Nueva evaluación en curso" : ""}
      </Button>
      <ModelResultsDialog
        record={{
          agentName,
          batches: history.length ? history : [batch],
          revision: currentRevision ?? batch.revision,
          versionNumber,
          committedMicrousd: totalCommittedMicrousd,
        }}
        initialBatchId={batch.id}
        open={open}
        onClose={() => setOpen(false)}
      />
    </>
  )
}
