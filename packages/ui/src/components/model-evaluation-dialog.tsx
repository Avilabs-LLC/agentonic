"use client"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowLeftIcon, LoaderCircleIcon, CheckIcon } from "lucide-react"
import {
  batchPassed,
  batchModelGroups,
  batchRunning,
  type ReviewPreparation,
} from "@agentonic/contracts/review-flow"
import {
  evaluationModels,
  modelCatalog,
  modelConfigurationKey,
  modelConfigurationLabel,
  reasoningLabels,
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
import { Checkbox } from "@base-ui/react/checkbox"
import { Field, FieldLabel } from "@workspace/ui/components/field"
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
const usd = (n: number) =>
  `US$${n.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
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
          revision={batch?.revision ?? record.revision}
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
                  {usd(
                    batch.models.reduce(
                      (sum, m) => sum + m.committedMicrousd,
                      0
                    ) / 1000000
                  )}{" "}
                  de {usd(batch.budgetUsd)}
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
                <Button variant="ghost" onClick={() => setSelectedModel(null)}>
                  <ArrowLeftIcon /> Todos los modelos
                </Button>
                {model.configurations.map((configuration) => (
                  <section key={configuration.id} className="space-y-4">
                    <h3 className="font-medium">
                      {modelConfigurationLabel(configuration)} ·{" "}
                      {configuration.passed}/{configuration.total} superadas
                    </h3>
                    {configuration.errorCode && (
                      <p className="text-sm text-destructive">
                        {configuration.errorCode === "budget_exhausted"
                          ? "Se alcanzó el límite de esta ejecución."
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
              <Table aria-label="Resultados por modelo">
                <TableHeader>
                  <TableRow>
                    <TableHead>Modelo</TableHead>
                    <TableHead>Situaciones</TableHead>
                    <TableHead>Resultado</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batchModelGroups(batch).map((m) => (
                    <TableRow key={m.model}>
                      <TableCell className="whitespace-normal">
                        <Button
                          variant="link"
                          className="h-auto flex-col items-start gap-1 p-0 text-left whitespace-normal text-foreground underline underline-offset-4"
                          onClick={() => setSelectedModel(m.model)}
                        >
                          {modelConfigurationLabel({
                            model: m.model,
                            reasoning: null,
                          })}
                          <span className="text-xs text-muted-foreground">
                            {" "}
                            · {m.configurations.length}{" "}
                            {m.configurations.length === 1
                              ? "nivel"
                              : "niveles"}
                          </span>
                        </Button>
                      </TableCell>
                      <TableCell>
                        {m.passed}/{m.total} superadas
                      </TableCell>
                      <TableCell>
                        <ReviewResultStatus
                          outcome={
                            m.status === "passed"
                              ? "passed"
                              : m.status === "failed"
                                ? "failed"
                                : ["queued", "running"].includes(m.status)
                                  ? "pending"
                                  : "attention"
                          }
                          label={
                            m.status === "passed"
                              ? "100 %"
                              : m.status === "queued"
                                ? "En cola"
                                : m.status === "running"
                                  ? "Evaluando"
                                  : m.status === "failed"
                                    ? "Con fallos"
                                    : "Interrumpida"
                          }
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </>
        )}
        {record.committedMicrousd !== undefined && (
          <p className="text-xs text-muted-foreground">
            Consumo acumulado, incluida la preparación y reservas pendientes:{" "}
            {usd(record.committedMicrousd / 1000000)}.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function RunModelEvaluationDialog({
  record,
  action,
  onClose,
  onStarted,
}: {
  record: ReviewPreparation
  action: (input: unknown) => Promise<FormResult>
  onClose: () => void
  onStarted: () => void
}) {
  const router = useRouter()
  const [models, setModels] = useState<ModelConfiguration[]>(
    () =>
      (record.batches[0]?.id !== record.evaluationId
        ? record.batches[0]?.models
        : undefined
      )?.flatMap((m) => {
        const value = evaluationModels.element.safeParse({
          model: m.model,
          reasoning: m.reasoning,
        })
        return value.success ? [value.data] : []
      }) ??
      modelCatalog.map((m) => ({ model: m.id, reasoning: m.defaultLevel }))
  )
  const [budget, setBudget] = useState("3")
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
    setModels((items) =>
      items.some(
        (m) => modelConfigurationKey(m) === modelConfigurationKey(configuration)
      )
        ? items.filter(
            (m) =>
              modelConfigurationKey(m) !== modelConfigurationKey(configuration)
          )
        : [...items, configuration]
    )
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
        <div className="space-y-4">
          {modelCatalog.map((m) => (
            <fieldset
              key={m.id}
              disabled={pending}
              className="space-y-2 border-b pb-4"
            >
              <legend className="mb-2 text-sm font-medium">{m.name}</legend>
              <div
                className="gap-2 sm:gap-x-4"
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                }}
              >
                {(m.levels.length ? m.levels : [null]).map((level) => (
                  <label
                    key={level ?? "default"}
                    className="flex min-h-10 cursor-pointer items-center gap-3 text-sm"
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
              changed()
            }}
          />
        </Field>
        <ConsentCheckbox
          checked={consent}
          onCheckedChange={(value) => setConsent(value === true)}
          disabled={pending}
        >
          Autorizo esta ejecución hasta {usd(Number(budget) || 0)}. Cada
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
