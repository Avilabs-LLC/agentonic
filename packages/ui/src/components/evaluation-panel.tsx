"use client"
import { useEffect, useId, useState } from "react"
import { useRouter } from "next/navigation"
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Checkbox } from "@base-ui/react/checkbox"
import { CheckIcon, PlusIcon, Trash2Icon } from "lucide-react"
import {
  evaluationCases,
  evaluationStatus,
  type EvaluationRecord,
} from "@agentonic/contracts/evaluation"
import type { FormResult } from "@agentonic/contracts/authoring"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@workspace/ui/components/card"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@workspace/ui/components/select"
import { notify } from "@workspace/ui/lib/toast"
type Action = (input: unknown) => Promise<FormResult>
const planSchema = z.object({
  cases: evaluationCases,
  environment: z.enum(["azure_staging", "local"]),
  budgetUsd: z
    .number()
    .min(0.01, "El mínimo es USD 0,01.")
    .max(1, "El máximo es USD 1."),
})
const blankCase = (key: string) => ({
  key,
  question: "",
  expectedAnswer: "",
  requiredPhrases: [] as string[],
  forbiddenPhrases: [] as string[],
  insufficientEvidence: false,
})
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
function PlanForm({
  submissionId,
  grantId,
  action,
}: {
  submissionId: string
  grantId: string
  action: Action
}) {
  const router = useRouter(),
    id = useId()
  const [error, setError] = useState("")
  const {
    register,
    control,
    handleSubmit,
    formState: { errors, isValid, isSubmitting },
  } = useForm<z.infer<typeof planSchema>>({
    resolver: zodResolver(planSchema),
    mode: "onChange",
    defaultValues: {
      cases: [blankCase("case-1"), blankCase("case-2"), blankCase("case-3")],
      environment: "azure_staging",
      budgetUsd: 0.25,
    },
  })
  const { fields, append, remove } = useFieldArray({ control, name: "cases" })
  return (
    <form
      className="space-y-5"
      onSubmit={handleSubmit(async (values) => {
        setError("")
        try {
          const result = await action({
            operation: "plan",
            payload: { submissionId, grantId, ...values },
          })
          if (!result.ok) {
            setError(result.message)
            notify.destructive(result.message)
          } else {
            notify.success(result.message)
            router.refresh()
          }
        } catch {
          setError("No se pudo proponer la evaluación.")
          notify.destructive("No se pudo proponer la evaluación.")
        }
      })}
    >
      <fieldset disabled={isSubmitting} className="space-y-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor={`${id}-environment`}>
              Entorno de evaluación
            </FieldLabel>
            <Controller
              control={control}
              name="environment"
              render={({ field }) => (
                <Select
                  items={{
                    azure_staging: "Azure · Staging",
                    local: "Mac · Desarrollo",
                  }}
                  value={field.value}
                  onValueChange={(value) => field.onChange(value)}
                >
                  <SelectTrigger id={`${id}-environment`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="azure_staging">
                      Azure · Staging
                    </SelectItem>
                    <SelectItem value="local">Mac · Desarrollo</SelectItem>
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-budget`}>
              Presupuesto máximo (USD)
            </FieldLabel>
            <Input
              id={`${id}-budget`}
              type="number"
              min="0.01"
              max="1"
              step="0.01"
              {...register("budgetUsd", { valueAsNumber: true })}
            />
            <FieldError errors={[errors.budgetUsd]} />
          </Field>
        </div>
        <p className="text-sm text-muted-foreground">
          Define entre 3 y 20 casos, incluyendo uno sin evidencia suficiente.
          Las frases y las citas se verifican automáticamente; el equipo debe
          revisar las respuestas antes de aprobar.
        </p>
        {fields.map((field, index) => (
          <div key={field.id} className="space-y-4 rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium">Caso {index + 1}</h3>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={fields.length <= 3}
                onClick={() => remove(index)}
                aria-label={`Eliminar caso ${index + 1}`}
              >
                <Trash2Icon />
              </Button>
            </div>
            <Field>
              <FieldLabel htmlFor={`${id}-${index}-question`}>
                Pregunta
              </FieldLabel>
              <Textarea
                id={`${id}-${index}-question`}
                {...register(`cases.${index}.question`)}
              />
              <FieldError errors={[errors.cases?.[index]?.question]} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-${index}-answer`}>
                Respuesta esperada
              </FieldLabel>
              <Textarea
                id={`${id}-${index}-answer`}
                {...register(`cases.${index}.expectedAnswer`)}
              />
              <FieldError errors={[errors.cases?.[index]?.expectedAnswer]} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              {(["requiredPhrases", "forbiddenPhrases"] as const).map(
                (name) => (
                  <Field key={name}>
                    <FieldLabel htmlFor={`${id}-${index}-${name}`}>
                      {name === "requiredPhrases"
                        ? "Frases necesarias"
                        : "Frases que no debe incluir"}
                    </FieldLabel>
                    <Controller
                      control={control}
                      name={`cases.${index}.${name}`}
                      render={({ field: f }) => (
                        <Textarea
                          id={`${id}-${index}-${name}`}
                          placeholder="Separa las frases con punto y coma"
                          defaultValue={f.value.join(";")}
                          onChange={(event) =>
                            f.onChange(
                              event.target.value
                                .split(";")
                                .map((value) => value.trim())
                                .filter(Boolean)
                            )
                          }
                        />
                      )}
                    />
                    <FieldError errors={[errors.cases?.[index]?.[name]]} />
                  </Field>
                )
              )}
            </div>
            <Controller
              control={control}
              name={`cases.${index}.insufficientEvidence`}
              render={({ field: f }) => (
                <Check checked={f.value} onChange={f.onChange}>
                  Debe indicar que no tiene evidencia suficiente.
                </Check>
              )}
            />
            <FieldError errors={[errors.cases?.[index]]} />
          </div>
        ))}
        <FieldError errors={[errors.cases?.root, errors.cases]} />
        <Button
          type="button"
          variant="outline"
          disabled={fields.length >= 20}
          onClick={() =>
            append(blankCase(`case-${crypto.randomUUID().slice(0, 8)}`))
          }
        >
          <PlusIcon />
          Agregar caso
        </Button>
      </fieldset>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={!isValid || isSubmitting}>
        {isSubmitting ? "Proponiendo…" : "Proponer evaluación"}
      </Button>
    </form>
  )
}
const confirmationSchema = z.object({
  confirmed: z.boolean().refine(Boolean, "Confirma la autorización."),
  feedback: z.string(),
})
function Confirmation({
  record,
  grantId,
  action,
  approve = false,
}: {
  record: EvaluationRecord
  grantId?: string
  action: Action
  approve?: boolean
}) {
  const router = useRouter(),
    id = useId()
  const {
    control,
    register,
    handleSubmit,
    formState: { isValid, isSubmitting },
  } = useForm({
    resolver: zodResolver(confirmationSchema),
    mode: "onChange",
    defaultValues: { confirmed: false, feedback: "" },
  })
  const feedback = useWatch({ control, name: "feedback" })
  const [error, setError] = useState("")
  return (
    <form
      className="space-y-4"
      onSubmit={handleSubmit(async (values) => {
        setError("")
        try {
          const result = await action(
            approve
              ? {
                  operation: "approve",
                  payload: {
                    evaluationId: record.id,
                    grantId,
                    evidenceHash: record.evidenceHash,
                    reviewed: true,
                    feedback: values.feedback,
                  },
                }
              : {
                  operation: "authorize",
                  payload: {
                    evaluationId: record.id,
                    datasetHash: record.datasetHash,
                    consent: true,
                  },
                }
          )
          if (!result.ok) {
            setError(result.message)
            notify.destructive(result.message)
          } else {
            notify.success(result.message)
            if (result.href) router.push(result.href)
            router.refresh()
          }
        } catch {
          setError("No se pudo completar la acción.")
          notify.destructive("No se pudo completar la acción.")
        }
      })}
    >
      {approve && (
        <Field>
          <FieldLabel htmlFor={id}>Conclusión de la revisión</FieldLabel>
          <Textarea
            id={id}
            minLength={10}
            maxLength={2000}
            {...register("feedback")}
          />
        </Field>
      )}
      <Controller
        control={control}
        name="confirmed"
        render={({ field }) => (
          <Check checked={field.value} onChange={field.onChange}>
            {approve
              ? "He revisado todas las respuestas y su evidencia. Apruebo esta versión y su alcance exacto; esta acción no la despliega."
              : `Autorizo estos casos y el uso del conocimiento seleccionado de esta versión para una evaluación privada en ${record.environment === "azure_staging" ? "Azure staging" : "desarrollo local"}, hasta USD ${record.budgetUsd.toFixed(2)}. El equipo podrá revisar los resultados. Puedo cancelar la autorización.`}
          </Check>
        )}
      />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button
        disabled={
          !isValid || isSubmitting || (approve && feedback.trim().length < 10)
        }
      >
        {isSubmitting
          ? "Guardando…"
          : approve
            ? "Aprobar versión"
            : "Autorizar evaluación"}
      </Button>
    </form>
  )
}
export function EvaluationPanel({
  records,
  action,
  submissionId,
  grantId,
  customer = false,
  labels = {},
}: {
  records: EvaluationRecord[]
  action: Action
  submissionId?: string
  grantId?: string
  customer?: boolean
  labels?: Record<string, string>
}) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  const active = records.some((r) => ["queued", "running"].includes(r.status))
  const hasRecords = records.length > 0
  useEffect(() => {
    if (!hasRecords) return
    const timer = setInterval(() => router.refresh(), active ? 4000 : 15000)
    return () => clearInterval(timer)
  }, [active, hasRecords, router])
  return (
    <Card>
      <CardHeader>
        <CardTitle>Evaluación de la versión</CardTitle>
        <CardDescription>
          Casos, resultados y autorización de la versión exacta enviada a
          revisión.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!records.length && (
          <p className="text-sm text-muted-foreground">
            Todavía no hay una evaluación propuesta.
          </p>
        )}
        {records.map((record) => (
          <section key={record.id} className="space-y-4 rounded-lg border p-4">
            {labels[record.submissionId] && (
              <h3 className="text-sm font-medium">
                {labels[record.submissionId]}
              </h3>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Badge
                variant={
                  record.status === "passed"
                    ? "success"
                    : record.status === "failed" || record.status === "error"
                      ? "error"
                      : "sky"
                }
              >
                {evaluationStatus[record.status]}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {record.environment === "azure_staging"
                  ? "Azure · Staging"
                  : "Mac · Desarrollo"}{" "}
                · {record.cases.length} casos · Máximo USD{" "}
                {record.budgetUsd.toFixed(2)}
              </span>
            </div>
            {record.authorized && (
              <p className="text-xs text-muted-foreground">
                Consumo y reservas: USD{" "}
                {(record.committedMicrousd / 1000000).toLocaleString("es-VE", {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 6,
                })}
              </p>
            )}
            <details className="text-sm">
              <summary className="cursor-pointer font-medium">
                Casos y resultados
              </summary>
              <div className="mt-4 space-y-4">
                {record.cases.map((test) => {
                  const result = record.results.find((r) => r.key === test.key)
                  return (
                    <div key={test.key} className="space-y-2 border-t pt-3">
                      <p className="font-medium">{test.question}</p>
                      <p>
                        <span className="text-muted-foreground">
                          Esperado:{" "}
                        </span>
                        {test.expectedAnswer}
                      </p>
                      {test.requiredPhrases.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Frases necesarias: {test.requiredPhrases.join("; ")}
                        </p>
                      )}
                      {test.forbiddenPhrases.length > 0 && (
                        <p className="text-xs text-muted-foreground">
                          Frases excluidas: {test.forbiddenPhrases.join("; ")}
                        </p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        {test.insufficientEvidence
                          ? "Debe indicar que no tiene evidencia suficiente."
                          : "Debe responder con citas de las fuentes autorizadas."}
                      </p>
                      {result && (
                        <>
                          <Badge
                            variant={
                              result.outcome === "passed" ? "success" : "error"
                            }
                          >
                            {result.outcome === "passed"
                              ? "Superado"
                              : "No superado"}
                          </Badge>
                          <p className="whitespace-pre-wrap">{result.answer}</p>
                          {result.sources.length > 0 && (
                            <details>
                              <summary className="cursor-pointer text-muted-foreground">
                                Ver evidencia citada
                              </summary>
                              <div className="mt-2 space-y-2">
                                {result.sources.map((source, index) => (
                                  <blockquote
                                    key={source.id}
                                    className="border-l-2 pl-3 text-sm whitespace-pre-wrap"
                                  >
                                    <span className="font-medium">
                                      Fuente {index + 1}:{" "}
                                    </span>
                                    {source.text}
                                  </blockquote>
                                ))}
                              </div>
                            </details>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {result.citations.length} citas ·{" "}
                            {
                              Object.values(result.checks).filter(Boolean)
                                .length
                            }{" "}
                            de {Object.keys(result.checks).length}{" "}
                            comprobaciones
                          </p>
                        </>
                      )}
                    </div>
                  )
                })}
              </div>
            </details>
            {record.status === "awaiting_consent" && !customer && (
              <p className="text-sm text-muted-foreground">
                El cliente debe revisar y autorizar estos casos desde la página
                de su agente.
              </p>
            )}
            {customer && record.canAuthorize && (
              <Confirmation record={record} action={action} />
            )}
            {!customer && record.status === "passed" && !record.canApprove && (
              <p className="text-sm text-muted-foreground">
                La aprobación requiere evidencia vigente en Azure staging,
                autorización actual y un rol de aprobación.
              </p>
            )}
            {!customer && record.canApprove && (
              <Confirmation
                record={record}
                grantId={grantId}
                action={action}
                approve
              />
            )}
            {record.canCancel && (
              <Button
                variant="outline"
                disabled={pending}
                onClick={async () => {
                  setPending(true)
                  try {
                    const result = await action({
                      operation: "cancel",
                      payload: { evaluationId: record.id },
                    })
                    if (result.ok) {
                      notify.success(result.message)
                      router.refresh()
                    } else notify.destructive(result.message)
                  } catch {
                    notify.destructive("No se pudo cancelar la evaluación.")
                  } finally {
                    setPending(false)
                  }
                }}
              >
                {record.authorized
                  ? "Cancelar autorización"
                  : "Cancelar evaluación"}
              </Button>
            )}
          </section>
        ))}
        {!customer &&
          submissionId &&
          grantId &&
          !records.some((r) =>
            ["awaiting_consent", "queued", "running"].includes(r.status)
          ) && (
            <details>
              <summary className="cursor-pointer text-sm font-medium">
                Proponer una evaluación
              </summary>
              <div className="mt-5">
                <PlanForm
                  submissionId={submissionId}
                  grantId={grantId}
                  action={action}
                />
              </div>
            </details>
          )}
      </CardContent>
    </Card>
  )
}
