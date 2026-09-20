"use client"
import {
  ModelResultsDialog,
  modelResultsLabel,
} from "@workspace/ui/components/model-evaluation-dialog"
import { batchRunning } from "@agentonic/contracts/review-flow"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import { useEffect, useId, useState } from "react"
import { useRouter } from "next/navigation"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Checkbox } from "@base-ui/react/checkbox"
import { CheckIcon, ClipboardCheckIcon } from "lucide-react"
import {
  type ReviewPreparation,
  type ReviewFlowState,
} from "@agentonic/contracts/review-flow"
import type { FormResult } from "@agentonic/contracts/authoring"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import { Button } from "@workspace/ui/components/button"
import { ReviewCriteriaDialog } from "@workspace/ui/components/review-criteria-dialog"
import { notify } from "@workspace/ui/lib/toast"
type Action = (input: unknown) => Promise<FormResult>
function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  children: React.ReactNode
}) {
  return (
    <label className="flex items-start gap-3 text-sm">
      <Checkbox.Root
        checked={checked}
        onCheckedChange={onChange}
        className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-sm border border-input focus-visible:ring-2 focus-visible:ring-ring data-checked:bg-primary data-checked:text-primary-foreground"
      >
        <Checkbox.Indicator>
          <CheckIcon className="size-3" />
        </Checkbox.Indicator>
      </Checkbox.Root>
      <span>{children}</span>
    </label>
  )
}
function useMutation(action: Action) {
  const router = useRouter()
  const [error, setError] = useState("")
  const [pending, setPending] = useState(false)
  async function run(input: unknown) {
    setPending(true)
    setError("")
    try {
      const result = await action(input)
      if (!result.ok) {
        setError(result.message)
        notify.destructive(result.message)
      } else {
        notify.success(result.message)
        router.refresh()
      }
      return result.ok
    } catch {
      setError("No se pudo completar la acción.")
      return false
    } finally {
      setPending(false)
    }
  }
  return { run, pending, error }
}
const prepareSchema = z.object({
  budgetUsd: z.number().min(0.05).max(1),
  consent: z.boolean().refine(Boolean, "Confirma la autorización."),
})
export function PreparationForm({
  submissionId,
  action,
}: {
  submissionId: string
  action: Action
}) {
  const id = useId()
  const mutation = useMutation(action)
  const [requestId] = useState(() => crypto.randomUUID())
  const {
    register,
    control,
    handleSubmit,
    formState: { isValid, errors },
  } = useForm({
    resolver: zodResolver(prepareSchema),
    mode: "onChange",
    defaultValues: { budgetUsd: 0.25, consent: false },
  })
  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit((values) =>
        mutation.run({
          operation: "prepare",
          payload: { submissionId, requestId, ...values },
        })
      )}
    >
      <fieldset disabled={mutation.pending} className="space-y-4">
        <Field>
          <FieldLabel htmlFor={id}>Límite total (USD)</FieldLabel>
          <Input
            id={id}
            type="number"
            min="0.05"
            max="1"
            step="0.01"
            className="max-w-48"
            {...register("budgetUsd", { valueAsNumber: true })}
          />
          <FieldError errors={[errors.budgetUsd]} />
        </Field>
        <p className="text-sm text-muted-foreground">
          Este límite cubre la preparación de criterios con IA. Cada evaluación
          se autoriza por separado.
        </p>
        <Controller
          control={control}
          name="consent"
          render={({ field }) => (
            <Check checked={field.value} onChange={field.onChange}>
              Autorizo el uso de IA con las instrucciones y el conocimiento
              seleccionado de esta versión para preparar la revisión, dentro de
              este límite. El equipo podrá consultar los criterios y resultados.
              Confirmaré los criterios antes de ejecutar las pruebas.
            </Check>
          )}
        />
        <Button type="submit" disabled={!isValid || mutation.pending}>
          {mutation.pending ? "Preparando…" : "Preparar criterios"}
        </Button>
      </fieldset>
      {mutation.error && (
        <p role="alert" className="text-sm text-destructive">
          {mutation.error}
        </p>
      )}
    </form>
  )
}
function ExceptionApproval({
  record,
  grantId,
  action,
}: {
  record: ReviewPreparation
  grantId: string
  action: Action
}) {
  const [reviewed, setReviewed] = useState(false),
    [feedback, setFeedback] = useState("")
  const id = useId()
  const mutation = useMutation(action)
  return (
    <form
      className="space-y-4 border-t pt-4"
      onSubmit={(e) => {
        e.preventDefault()
        void mutation.run({
          operation: "approve",
          payload: {
            evaluationId: record.evaluationId,
            grantId,
            evidenceHash: record.evidenceHash,
            reviewed: true,
            feedback,
          },
        })
      }}
    >
      <Field>
        <FieldLabel htmlFor={id}>
          Conclusión de la revisión excepcional
        </FieldLabel>
        <Textarea
          id={id}
          minLength={10}
          maxLength={2000}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          required
        />
      </Field>
      <Check checked={reviewed} onChange={setReviewed}>
        Revisé las respuestas, la evidencia y el motivo por el que esta versión
        requiere atención. Apruebo esta versión y su alcance.
      </Check>
      <Button
        type="submit"
        disabled={!reviewed || feedback.trim().length < 10 || mutation.pending}
      >
        Aprobar versión
      </Button>
      {mutation.error && (
        <p role="alert" className="text-sm text-destructive">
          {mutation.error}
        </p>
      )}
    </form>
  )
}
export function Preparation({
  record,
  action,
  grantId,
  approveAction,
  showCancel = true,
}: {
  record: ReviewPreparation
  showCancel?: boolean
  action?: Action
  grantId?: string
  approveAction?: Action
}) {
  const mutation = useMutation(
    action ?? (async () => ({ ok: false, message: "Acción no disponible." }))
  )
  const [resultsOpen, setResultsOpen] = useState(false)
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <ReviewCriteriaDialog
          record={record}
          action={action}
          label="Ver criterios"
        />
        <Button
          variant="outline"
          disabled={!record.batches.length}
          onClick={() => setResultsOpen(true)}
        >
          {modelResultsLabel(record)}
        </Button>
      </div>
      <ModelResultsDialog
        record={record}
        open={resultsOpen}
        onClose={() => setResultsOpen(false)}
      />
      {record.canApprove && grantId && approveAction && (
        <ExceptionApproval
          record={record}
          grantId={grantId}
          action={approveAction}
        />
      )}
      {showCancel && record.canCancel && action && (
        <Button
          variant="ghost"
          disabled={mutation.pending}
          onClick={() =>
            mutation.run({
              operation: "cancel",
              payload: { preparationId: record.id },
            })
          }
        >
          Cancelar autorización
        </Button>
      )}
      {mutation.error && (
        <p role="alert" className="text-sm text-destructive">
          {mutation.error}
        </p>
      )}
    </section>
  )
}
export function ReviewFlowPanel({
  state,
  submissionId,
  action,
  grantId,
  approveAction,
}: {
  state: ReviewFlowState
  submissionId?: string
  action?: Action
  grantId?: string
  approveAction?: Action
}) {
  const router = useRouter()
  const active = state.preparations.some(
    (p) =>
      ["queued", "preparing"].includes(p.status) || batchRunning(p.batches[0])
  )
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), active ? 4000 : 15000)
    return () => clearInterval(timer)
  }, [active, router])
  const latest = state.preparations[0]
  return (
    <AgentSettingsCard
      title="Revisión de la versión"
      icon={<ClipboardCheckIcon />}
      description="La IA propone preguntas y respuestas esperadas a partir de las instrucciones y una muestra del conocimiento autorizado. El cliente las ajusta y confirma antes de evaluar la versión."
    >
      <div className="space-y-6">
        {latest && (
          <Preparation
            record={latest}
            action={action}
            grantId={grantId}
            approveAction={approveAction}
          />
        )}
        {state.canPrepare && submissionId && action ? (
          <PreparationForm submissionId={submissionId} action={action} />
        ) : (
          !latest && (
            <CardEmptyState title="Sin revisión preparada">
              {action
                ? "Envía una versión a revisión para preparar sus criterios. Si ya la enviaste, la preparación estará disponible cuando el servicio de evaluación esté habilitado para esa versión."
                : "El cliente inicia la preparación desde su agente. Aquí aparecerán los criterios confirmados, sus comentarios y el resultado automático."}
            </CardEmptyState>
          )
        )}
        {state.preparations.length > 1 && (
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              Revisiones anteriores
            </summary>
            <div className="mt-4 space-y-6">
              {state.preparations.slice(1).map((p) => (
                <Preparation
                  key={p.id}
                  record={p}
                  action={action}
                  grantId={grantId}
                  approveAction={approveAction}
                />
              ))}
            </div>
          </details>
        )}
      </div>
    </AgentSettingsCard>
  )
}
