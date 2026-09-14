"use client"
import { useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"
import { CheckIcon, CircleIcon } from "lucide-react"
import type {
  AgentView,
  WorkspaceView,
  FormResult,
} from "@agentonic/contracts/authoring"
import {
  freezeForm,
  submissionForm,
  workflowRequirements,
  draftEditorForm,
  type DraftFormValues,
  type DraftEditorStatus,
  type Requirement,
} from "@agentonic/contracts/workflow"
import { DraftEditor } from "@workspace/ui/components/draft-editor"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@workspace/ui/components/card"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@workspace/ui/components/select"
import { ConsentCheckbox } from "@workspace/ui/components/consent-checkbox"
import { notify } from "@workspace/ui/lib/toast"

type Base = Omit<
  Parameters<typeof workflowRequirements>[0],
  "codeReleaseId" | "candidateId" | "consent" | "note"
>
type Run = (kind: "freeze" | "submit", values: FormData) => Promise<void>
function Requirements({
  items,
  label,
}: {
  items: Requirement[]
  label: string
}) {
  return (
    <ul
      aria-label={label}
      className="space-y-2 border-t pt-4 text-xs text-muted-foreground"
    >
      {items.map((item) => (
        <li key={item.label} className="flex items-start gap-2">
          {item.met ? (
            <CheckIcon
              className="mt-0.5 size-3.5 shrink-0 text-primary"
              aria-hidden="true"
            />
          ) : (
            <CircleIcon
              className="mt-0.5 size-3.5 shrink-0"
              aria-hidden="true"
            />
          )}
          <span>
            <span className="sr-only">
              {item.met ? "Cumplido: " : "Pendiente: "}
            </span>
            {item.label}
          </span>
        </li>
      ))}
    </ul>
  )
}
function StepCard({
  step,
  title,
  description,
  children,
}: {
  step: string
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <Card className="min-w-0 gap-5 py-6 [--card-spacing:--spacing(6)]">
      <CardHeader className="gap-2">
        <span className="mb-1 text-sm font-medium text-muted-foreground">
          {step}
        </span>
        <CardTitle>
          <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
        </CardTitle>
        <CardDescription className="text-sm leading-relaxed">
          {description}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">{children}</CardContent>
    </Card>
  )
}
function FreezeStep({
  base,
  codes,
  run,
}: {
  base: Base
  codes: WorkspaceView["templates"]
  run: Run
}) {
  const {
    control,
    handleSubmit,
    formState: { isValid, isSubmitting },
  } = useForm<z.infer<typeof freezeForm>>({
    resolver: zodResolver(freezeForm),
    mode: "onChange",
    defaultValues: { codeReleaseId: codes[0]?.codeReleaseId ?? "" },
  })
  const codeReleaseId = useWatch({ control, name: "codeReleaseId" })
  const readiness = workflowRequirements({
    ...base,
    codeReleaseId,
    candidateId: "",
    consent: false,
    note: "",
  })
  const enabled = readiness.canFreeze && isValid && !isSubmitting
  return (
    <StepCard
      step="Paso 1 · Congelar"
      title="Preparar versión"
      description="Congela el borrador guardado."
    >
      <form
        noValidate
        className="flex flex-1 flex-col gap-4"
        onSubmit={handleSubmit(async (values) => {
          if (!enabled) return
          const form = new FormData()
          form.set("revision", String(base.draft.revision))
          form.set("codeReleaseId", values.codeReleaseId)
          await run("freeze", form)
        })}
      >
        <fieldset
          disabled={base.busy || base.editor.pending}
          className="flex-1 space-y-4"
        >
          <Field>
            <FieldLabel htmlFor="freeze-code">Versión disponible</FieldLabel>
            <Controller
              control={control}
              name="codeReleaseId"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  items={codes.map((c) => ({
                    value: c.codeReleaseId,
                    label: `${c.name} · ${c.codeVersion}`,
                  }))}
                >
                  <SelectTrigger id="freeze-code" className="w-full">
                    <SelectValue placeholder="Sin versión disponible" />
                  </SelectTrigger>
                  <SelectContent>
                    {codes.map((c) => (
                      <SelectItem key={c.codeReleaseId} value={c.codeReleaseId}>
                        {c.name} · {c.codeVersion}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          <p className="text-sm text-muted-foreground">
            Congelar no aprueba ni despliega el agente. Las pruebas de chat y
            evaluaciones aún no están disponibles.
          </p>
          <Requirements
            items={readiness.freeze}
            label="Requisitos para congelar"
          />
        </fieldset>
        <Button type="submit" className="self-start" disabled={!enabled}>
          {base.busy && isSubmitting ? "Congelando…" : "Congelar versión"}
        </Button>
      </form>
    </StepCard>
  )
}
function ReviewStep({ base, run }: { base: Base; run: Run }) {
  const candidates = base.candidates.filter(
    (c) =>
      c.canSubmit &&
      c.revision === base.draft.revision &&
      !base.submittedCandidateIds.includes(c.id)
  )
  const {
    control,
    register,
    handleSubmit,
    formState: { isValid, isSubmitting, errors },
  } = useForm<z.infer<typeof submissionForm>>({
    resolver: zodResolver(submissionForm),
    mode: "onChange",
    defaultValues: {
      candidateId: candidates[0]?.id ?? "",
      note: "",
      consent: false,
    },
  })
  const candidateId = useWatch({ control, name: "candidateId" })
  const note = useWatch({ control, name: "note" })
  const consent = useWatch({ control, name: "consent" })
  const readiness = workflowRequirements({
    ...base,
    codeReleaseId: "",
    candidateId,
    note,
    consent,
  })
  const enabled = readiness.canSubmit && isValid && !isSubmitting
  return (
    <StepCard
      step="Paso 2 · Enviar"
      title="Enviar a revisión"
      description="Comparte una versión exacta con nuestro equipo."
    >
      <form
        noValidate
        className="flex flex-1 flex-col gap-4"
        onSubmit={handleSubmit(async (values) => {
          if (!enabled) return
          const form = new FormData()
          form.set("candidateId", values.candidateId)
          form.set("note", values.note)
          form.set("consent", "on")
          form.set("revision", String(base.draft.revision))
          await run("submit", form)
        })}
      >
        <fieldset
          disabled={base.busy || base.editor.pending}
          className="flex-1 space-y-4"
        >
          <Field>
            <FieldLabel htmlFor="review-candidate">
              Versión congelada
            </FieldLabel>
            <Controller
              control={control}
              name="candidateId"
              render={({ field }) => (
                <Select
                  value={field.value}
                  onValueChange={field.onChange}
                  items={candidates.map((c) => ({
                    value: c.id,
                    label: `Revisión ${c.revision}`,
                  }))}
                >
                  <SelectTrigger
                    id="review-candidate"
                    className="w-full"
                    disabled={!candidates.length}
                  >
                    <SelectValue placeholder="Completa el paso 1" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        Revisión {c.revision}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </Field>
          {!candidates.length && (
            <p className="text-sm text-muted-foreground">
              Guarda y congela una nueva revisión disponible para enviarla.
            </p>
          )}
          <Field data-invalid={!!errors.note}>
            <FieldLabel htmlFor="review-note">
              Nota para el equipo (opcional)
            </FieldLabel>
            <Textarea
              id="review-note"
              maxLength={2000}
              aria-invalid={!!errors.note}
              {...register("note")}
              disabled={!candidates.length}
            />
            <FieldError errors={[errors.note]} />
          </Field>
          <Controller
            control={control}
            name="consent"
            render={({ field }) => (
              <ConsentCheckbox
                checked={field.value}
                onCheckedChange={field.onChange}
                disabled={
                  !candidates.length || base.busy || base.editor.pending
                }
              />
            )}
          />
          <Requirements
            items={readiness.submit}
            label="Requisitos para enviar a revisión"
          />
        </fieldset>
        <Button type="submit" className="self-start" disabled={!enabled}>
          {base.busy && isSubmitting ? "Enviando…" : "Enviar propuesta"}
        </Button>
      </form>
    </StepCard>
  )
}
export function AgentWorkflow({
  data,
  collections,
  codes,
  save,
  freeze,
  submit,
}: {
  data: AgentView
  collections: WorkspaceView["collections"]
  codes: WorkspaceView["templates"]
  save: (values: FormData) => Promise<FormResult>
  freeze: (values: FormData) => Promise<FormResult>
  submit: (values: FormData) => Promise<FormResult>
}) {
  const router = useRouter()
  const form = useForm<DraftFormValues>({
    resolver: zodResolver(draftEditorForm),
    mode: "onChange",
    defaultValues: {
      content: data.draft.content,
      collectionIds: data.draft.requestedAccess.collectionIds,
    },
  })
  const [editingSkill, setEditingSkill] = useState(false)
  const editor: DraftEditorStatus = {
    dirty: form.formState.isDirty,
    valid: form.formState.isValid,
    pending: form.formState.isSubmitting,
    editingSkill,
  }
  const [working, setWorking] = useState(false)
  const [refreshing, startRefresh] = useTransition()
  const [message, setMessage] = useState("")
  const busy = working || refreshing
  const base: Base = {
    draft: data.draft,
    editor,
    candidates: data.candidates,
    submittedCandidateIds: data.submissions.map((s) => s.candidateId),
    availableCollectionIds: collections.map((c) => c.id),
    availableCodeIds: codes.map((c) => c.codeReleaseId),
    busy,
  }
  const run: Run = async (kind, values) => {
    if (busy || editor.pending || editingSkill) return
    const current = form.getValues()
    if (
      !draftEditorForm.safeParse(current).success ||
      JSON.stringify(current) !==
        JSON.stringify({
          content: data.draft.content,
          collectionIds: data.draft.requestedAccess.collectionIds,
        })
    )
      return
    setWorking(true)
    setMessage("")
    try {
      const result = await (kind === "freeze" ? freeze : submit)(values)
      if (!result.ok) {
        setMessage(result.message)
        notify.destructive(result.message)
        return
      }
      notify.success(result.message)
      startRefresh(() => router.refresh())
    } catch {
      const text =
        "No se pudo confirmar la acción. Conservamos tus campos; comprueba el estado antes de volver a intentarlo."
      setMessage(text)
      notify.destructive(text)
    } finally {
      setWorking(false)
    }
  }
  const candidateKey = data.candidates
    .filter(
      (c) =>
        c.canSubmit &&
        c.revision === data.draft.revision &&
        !base.submittedCandidateIds.includes(c.id)
    )
    .map((c) => c.id)
    .join(":")
  return (
    <>
      <DraftEditor
        draft={data.draft}
        collections={collections}
        action={save}
        disabled={busy}
        form={form}
        onEditingSkillChange={setEditingSkill}
      />
      <section aria-labelledby="review-flow-title" className="space-y-5">
        <div className="space-y-2">
          <h2
            id="review-flow-title"
            className="text-2xl font-semibold tracking-tight"
          >
            Prepara y envía tu versión
          </h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            Primero guarda y congela tu configuración. Después, autoriza el
            acceso y envía esa versión a revisión. Las habilidades y colecciones
            son opcionales.
          </p>
        </div>
        {message && (
          <p role="alert" className="text-sm text-destructive">
            {message}
          </p>
        )}
        <div className="grid auto-rows-fr items-stretch gap-6 lg:grid-cols-2">
          <FreezeStep base={base} codes={codes} run={run} />
          <ReviewStep key={candidateKey} base={base} run={run} />
        </div>
      </section>
    </>
  )
}
