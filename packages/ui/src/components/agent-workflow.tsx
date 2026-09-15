"use client"
import { useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"
import {
  CheckIcon,
  CircleIcon,
  PlayIcon,
  MessageSquareIcon,
} from "lucide-react"
import type {
  AgentView,
  WorkspaceView,
  FormResult,
} from "@agentonic/contracts/authoring"
import {
  submissionForm,
  workflowRequirements,
  reviewPreparation,
  preparedVersionLabel,
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
import { Badge } from "@workspace/ui/components/badge"
import { ConsentCheckbox } from "@workspace/ui/components/consent-checkbox"
import { notify } from "@workspace/ui/lib/toast"

type Base = Omit<
  Parameters<typeof workflowRequirements>[0],
  "codeReleaseId" | "candidateId" | "consent" | "note"
>
type Run = (
  kind: "prepare" | "preview" | "submit",
  values: FormData
) => Promise<void>
function Requirements({
  items,
  label,
}: {
  items: Requirement[]
  label: string
}) {
  if (!items.length) return null
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
function ReviewVersionCard({ base, run }: { base: Base; run: Run }) {
  const { current, previous } = reviewPreparation(
    base.draft,
    base.candidates,
    base.availableCodeIds[0] ?? null
  )
  const candidate = current ?? previous
  const submitted = !!current && base.submittedCandidateIds.includes(current.id)
  const reviewAvailable = !!current?.canSubmit && !submitted
  const {
    control,
    register,
    handleSubmit,
    formState: { isValid, isSubmitting, errors },
  } = useForm<z.infer<typeof submissionForm>>({
    resolver: zodResolver(submissionForm),
    mode: "onChange",
    defaultValues: { candidateId: current?.id ?? "", note: "", consent: false },
  })
  const note = useWatch({ control, name: "note" })
  const consent = useWatch({ control, name: "consent" })
  const readiness = workflowRequirements({
    ...base,
    codeReleaseId: base.availableCodeIds[0] ?? "",
    candidateId: current?.id ?? "",
    note,
    consent,
  })
  const locked = base.busy || base.editor.pending || isSubmitting
  const clean = !base.editor.dirty && !base.editor.editingSkill
  const label = candidate
    ? preparedVersionLabel(candidate)
    : "Sin versión preparada"
  const prepare = async () => {
    if (!readiness.canFreeze || locked) return
    const form = new FormData()
    form.set("revision", String(base.draft.revision))
    await run("prepare", form)
  }
  const preview = async () => {
    if (!candidate || locked || !clean) return
    const form = new FormData()
    form.set("revision", String(base.draft.revision))
    form.set("candidateId", candidate.id)
    await run("preview", form)
  }
  return (
    <Card className="min-w-0 gap-5 py-6 [--card-spacing:--spacing(6)]">
      <CardHeader className="gap-2">
        <CardTitle>
          <h2 className="text-xl font-semibold tracking-tight">
            Versión para revisión
          </h2>
        </CardTitle>
        <CardDescription className="text-sm leading-relaxed">
          Prepara una versión de tu agente, pruébala y envíala a nuestro equipo
          cuando esté lista.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Badge variant={current ? "sky" : "slate"}>{label}</Badge>
          <p className="text-sm text-muted-foreground">
            {current
              ? `${label} conserva la revisión ${current.revision} del borrador. Probarla no modifica sus instrucciones, habilidades ni conocimiento.`
              : previous
                ? `La prueba anterior usa ${preparedVersionLabel(previous)}, preparada desde la revisión ${previous.revision}. Los cambios guardados todavía no forman parte de esa versión.`
                : "Guarda el borrador y prepara una versión fija de sus instrucciones, habilidades y conocimiento. Agentonic se encarga de la configuración técnica."}
          </p>
          {candidate?.createdAt && (
            <p className="text-xs text-muted-foreground">
              Preparada el{" "}
              {new Intl.DateTimeFormat("es-VE", {
                dateStyle: "medium",
                timeZone: "UTC",
              }).format(new Date(candidate.createdAt))}
            </p>
          )}
          {!clean && (
            <p role="status" className="text-sm text-muted-foreground">
              Guarda los cambios y cierra los diálogos antes de continuar. La
              versión preparada conserva la configuración anterior.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-3">
          {!current && (
            <Button
              disabled={!readiness.canFreeze || locked}
              onClick={() => void prepare()}
            >
              <PlayIcon aria-hidden="true" />
              {base.busy
                ? "Preparando…"
                : previous
                  ? "Preparar y probar cambios"
                  : "Preparar y probar"}
            </Button>
          )}
          {candidate && (
            <Button
              variant={current ? "default" : "outline"}
              disabled={locked || !clean}
              onClick={() => void preview()}
            >
              <MessageSquareIcon aria-hidden="true" />
              {current ? "Continuar prueba" : "Probar versión anterior"}
            </Button>
          )}
        </div>
        {!current && (
          <Requirements
            label="Pendiente para preparar la versión"
            items={readiness.freeze.filter((item) => !item.met)}
          />
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          Prueba privada de hasta 10 minutos y 10 mensajes, con un máximo de
          US$0,25. Si sigue activa, se retoma la misma conversación; si venció,
          comienza otra. Preparar y probar no aprueba ni despliega el agente.
        </p>
        {reviewAvailable && (
          <form
            noValidate
            className="space-y-4 border-t pt-5"
            onSubmit={handleSubmit(async (values) => {
              if (!readiness.canSubmit || !isValid || locked) return
              const form = new FormData()
              form.set("candidateId", values.candidateId)
              form.set("revision", String(base.draft.revision))
              form.set("note", values.note)
              form.set("consent", "on")
              await run("submit", form)
            })}
          >
            <p className="text-sm">
              Al enviar, el equipo revisará exactamente{" "}
              {preparedVersionLabel(current)}. La prueba por sí sola no acredita
              su calidad.
            </p>
            <Field data-invalid={!!errors.note}>
              <FieldLabel htmlFor="review-note">
                Nota para el equipo (opcional)
              </FieldLabel>
              <Textarea
                id="review-note"
                maxLength={2000}
                aria-invalid={!!errors.note}
                disabled={locked}
                {...register("note")}
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
                  disabled={locked || !clean}
                />
              )}
            />
            <Button
              type="submit"
              disabled={!readiness.canSubmit || !isValid || locked}
            >
              {isSubmitting ? "Enviando…" : "Enviar a revisión"}
            </Button>
          </form>
        )}
        {submitted && (
          <p
            role="status"
            className="border-t pt-5 text-sm text-muted-foreground"
          >
            Esta versión ya fue enviada. Consulta su estado en Propuestas y
            comentarios. Para enviar otra propuesta, guarda cambios y prepara
            una nueva versión.
          </p>
        )}
        {current && !submitted && !reviewAvailable && (
          <p
            role="status"
            className="border-t pt-5 text-sm text-muted-foreground"
          >
            Esta versión no está disponible para revisión. Comprueba tus
            permisos sobre el conocimiento seleccionado.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
export function AgentWorkflow({
  data,
  collections,
  save,
  prepare,
  submit,
}: {
  data: AgentView
  collections: WorkspaceView["collections"]
  save: (values: FormData) => Promise<FormResult>
  prepare: (values: FormData) => Promise<FormResult>
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
  const mutationLock = useRef(false)
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
    availableCodeIds: data.preparationCodeReleaseId
      ? [data.preparationCodeReleaseId]
      : [],
    busy,
  }
  const run: Run = async (kind, values) => {
    if (mutationLock.current || busy || editor.pending || editingSkill) return
    const current = form.getValues()
    if (
      (kind !== "preview" && !draftEditorForm.safeParse(current).success) ||
      JSON.stringify(current) !==
        JSON.stringify({
          content: data.draft.content,
          collectionIds: data.draft.requestedAccess.collectionIds,
        })
    )
      return
    mutationLock.current = true
    setWorking(true)
    setMessage("")
    try {
      const result = await (kind === "submit" ? submit : prepare)(values)
      if (!result.ok) {
        setMessage(result.message)
        notify.destructive(result.message)
        return
      }
      notify.success(result.message)
      startRefresh(() => {
        if (result.href) router.push(result.href)
        else router.refresh()
      })
    } catch {
      const text =
        "No se pudo confirmar la acción. Conservamos tus campos; comprueba el estado antes de volver a intentarlo."
      setMessage(text)
      notify.destructive(text)
    } finally {
      mutationLock.current = false
      setWorking(false)
    }
  }
  const candidateKey = `${data.draft.revision}:${data.preparationCodeReleaseId}:${data.candidates.map((c) => `${c.id}:${c.canSubmit}:${c.canPreview}`).join(":")}:${base.submittedCandidateIds.join(":")}`
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
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <ReviewVersionCard key={candidateKey} base={base} run={run} />
    </>
  )
}
