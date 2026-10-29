"use client"
import type { GmailState } from "@agentonic/contracts/gmail"
import type { DriveState } from "@agentonic/contracts/drive"
import {
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react"
import { useRouter } from "next/navigation"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"
import {
  CheckIcon,
  CircleIcon,
  SendIcon,
  PackageIcon,
  PackageOpenIcon,
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
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import { ConsentCheckbox } from "@workspace/ui/components/consent-checkbox"
import { IconTile } from "@workspace/ui/components/icon-tile"
import { notify } from "@workspace/ui/lib/toast"

/**
 * The Borrador and version frames side by side: one anatomy, the state note in
 * the violet highlight, and a body at least four lines tall, so both frames
 * end at the same height whether their text runs one line or four.
 */
function VersionFrame({
  tone,
  title,
  revision,
  state,
  children,
}: {
  tone: "yellow" | "sky"
  title: string
  revision: number
  state: string
  children: ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-lg border bg-muted/20">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
        <div className="flex items-center gap-3">
          <IconTile tone={tone}>
            <PackageIcon aria-hidden="true" />
          </IconTile>
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{title}</p>
            <p className="font-mono text-xs text-muted-foreground">
              Edición {revision}
            </p>
          </div>
        </div>
        <span className="text-[0.8125rem] text-highlight">{state}</span>
      </div>
      <div className="min-h-[calc(4lh+2rem)] p-4 text-sm leading-relaxed text-muted-foreground">
        {children}
      </div>
    </div>
  )
}
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
export function VersionCards({
  base,
  run,
  message,
  pendingAction,
}: {
  base: Base
  run: Run
  message: string
  pendingAction: "prepare" | "preview" | "submit" | null
}) {
  const [reviewOpen, setReviewOpen] = useState(false)
  const [submissionRequest] = useState(() => crypto.randomUUID())
  const { current } = reviewPreparation(
    base.draft,
    base.candidates,
    base.availableCodeIds[0] ?? null
  )
  const candidate = base.candidates[0]
  const [expiredPreview, setExpiredPreview] = useState<string | null>(null)
  const hasActivePreview =
    !!candidate?.previewExpiresAt &&
    expiredPreview !== candidate.previewExpiresAt
  useEffect(() => {
    const expiresAt = candidate?.previewExpiresAt
    if (!expiresAt) return
    const remaining = new Date(expiresAt).getTime() - Date.now()
    const timer = setTimeout(
      () => setExpiredPreview(expiresAt),
      Math.max(0, remaining)
    )
    return () => clearTimeout(timer)
  }, [candidate?.previewExpiresAt])
  const submitted =
    !!candidate && base.submittedCandidateIds.includes(candidate.id)
  const reviewAvailable = !!current?.canSubmit && !submitted
  const {
    control,
    register,
    handleSubmit,
    formState: { isValid, isSubmitting, errors },
  } = useForm<z.infer<typeof submissionForm>>({
    resolver: zodResolver(submissionForm),
    mode: "onChange",
    defaultValues: {
      candidateId: current?.id ?? "",
      note: "",
      budgetUsd: 0.25,
      consent: false,
    },
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
    if (!candidate?.canPreview || locked || !clean) return
    const form = new FormData()
    form.set("revision", String(base.draft.revision))
    form.set("candidateId", candidate.id)
    await run("preview", form)
  }
  return (
    <div className="grid items-stretch gap-6 lg:grid-cols-2">
      <Card className="min-w-0 gap-5 py-6 [--card-spacing:--spacing(6)]">
        <CardHeader className="gap-2">
          <CardTitle>
            <h2 className="text-xl font-semibold tracking-tight">
              Nueva versión
            </h2>
          </CardTitle>
          <CardDescription>
            Genera una versión a partir del borrador guardado.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-5">
          <VersionFrame
            tone="yellow"
            title="Borrador"
            revision={base.draft.revision}
            state={
              !clean
                ? "Cambios sin guardar"
                : current
                  ? "Sin cambios nuevos"
                  : "Por preparar"
            }
          >
            <p>
              {!clean
                ? "Guarda los cambios y cierra los diálogos antes de preparar una nueva versión."
                : current
                  ? "Los cambios guardados ya están en la versión actual. Edita y guarda el borrador para preparar otra."
                  : "Se creará una versión fija de tus instrucciones, habilidades y conocimiento."}
            </p>
          </VersionFrame>
          {!current && (
            <Requirements
              label="Pendiente para preparar la versión"
              items={readiness.freeze.filter((item) => !item.met)}
            />
          )}
          <div className="mt-auto space-y-3 border-t pt-5">
            <Button
              disabled={!!current || !readiness.canFreeze || locked}
              onClick={() => void prepare()}
            >
              {pendingAction === "prepare" ? "Preparando…" : "Preparar versión"}
            </Button>
          </div>
        </CardContent>
      </Card>
      <Card className="min-w-0 gap-5 py-6 [--card-spacing:--spacing(6)]">
        <CardHeader className="gap-2">
          <CardTitle>
            <h2 className="text-xl font-semibold tracking-tight">
              Versión actual
            </h2>
          </CardTitle>
          <CardDescription>
            La última versión preparada de tu agente.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-5">
          {candidate ? (
            <>
              <VersionFrame
                tone="sky"
                title={label}
                revision={candidate.revision}
                state={
                  submitted
                    ? "Enviada a revisión"
                    : candidate.canPreview
                      ? "Preparada"
                      : "Prueba no disponible"
                }
              >
                {candidate.createdAt && (
                  <p>
                    Preparada el{" "}
                    <span className="font-medium text-foreground">
                      {new Intl.DateTimeFormat("es-VE", {
                        dateStyle: "medium",
                        timeZone: "UTC",
                      }).format(new Date(candidate.createdAt))}
                    </span>
                  </p>
                )}
                <p>
                  {current
                    ? "Esta versión incluye los últimos cambios guardados."
                    : "Los cambios del borrador todavía no forman parte de esta versión."}
                </p>
              </VersionFrame>
              {!clean && (
                <p role="status" className="text-sm text-muted-foreground">
                  Guarda los cambios y cierra los diálogos antes de continuar.
                </p>
              )}
              <div className="mt-auto flex flex-wrap gap-3 border-t pt-5">
                <Button
                  variant="outline"
                  disabled={!candidate.canPreview || locked || !clean}
                  onClick={() => void preview()}
                >
                  {pendingAction === "preview"
                    ? "Abriendo…"
                    : hasActivePreview
                      ? "Continuar prueba"
                      : "Probar agente"}
                </Button>
                {reviewAvailable && (
                  <Dialog
                    open={reviewOpen}
                    onOpenChange={(open) => {
                      if (!locked) setReviewOpen(open)
                    }}
                  >
                    <DialogTrigger
                      render={<Button disabled={locked || !clean} />}
                    >
                      <SendIcon aria-hidden="true" />
                      Enviar a revisión
                    </DialogTrigger>
                    <DialogContent showCloseButton={!locked}>
                      <DialogHeader>
                        <DialogTitle>
                          Enviar {label.toLowerCase()} a revisión
                        </DialogTitle>
                        <DialogDescription>
                          Prepararemos los criterios con IA. Podrás revisarlos y
                          confirmarlos antes de ejecutar las pruebas.
                        </DialogDescription>
                      </DialogHeader>
                      <form
                        noValidate
                        className="space-y-4"
                        onSubmit={handleSubmit(async (values) => {
                          if (!readiness.canSubmit || !isValid || locked) return
                          const form = new FormData()
                          form.set("candidateId", values.candidateId)
                          form.set("revision", String(base.draft.revision))
                          form.set("note", values.note)
                          form.set("consent", "on")
                          form.set("budgetUsd", String(values.budgetUsd))
                          form.set("requestId", submissionRequest)
                          await run("submit", form)
                        })}
                      >
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
                        <Field data-invalid={!!errors.budgetUsd}>
                          <FieldLabel htmlFor="review-budget">
                            Límite para preparar criterios (USD)
                          </FieldLabel>
                          <Input
                            id="review-budget"
                            type="number"
                            min="0.1"
                            max="1"
                            step="0.01"
                            className="max-w-48"
                            disabled={locked}
                            {...register("budgetUsd", { valueAsNumber: true })}
                          />
                          <FieldError errors={[errors.budgetUsd]} />
                          <p className="text-xs text-muted-foreground">
                            Cubre la preparación de criterios con IA.
                            Autorizarás cada evaluación por separado.
                          </p>
                        </Field>
                        <Controller
                          control={control}
                          name="consent"
                          render={({ field }) => (
                            <ConsentCheckbox
                              checked={field.value}
                              onCheckedChange={field.onChange}
                              disabled={locked || !clean}
                            >
                              Autorizo durante 7 días la revisión de esta
                              versión por el equipo y el uso de IA con sus
                              instrucciones y conocimiento seleccionado, dentro
                              de este límite. El equipo podrá consultar los
                              criterios y resultados. Confirmaré los criterios
                              antes de ejecutar las pruebas. Puedo retirar la
                              propuesta para revocar el acceso.
                            </ConsentCheckbox>
                          )}
                        />
                        {message && (
                          <p role="alert" className="text-sm text-destructive">
                            {message}
                          </p>
                        )}
                        <div className="flex justify-end gap-3">
                          <Button
                            type="button"
                            variant="outline"
                            disabled={locked}
                            onClick={() => setReviewOpen(false)}
                          >
                            Cancelar
                          </Button>
                          <Button
                            type="submit"
                            disabled={
                              !readiness.canSubmit || !isValid || locked
                            }
                          >
                            <SendIcon aria-hidden="true" />
                            {isSubmitting ? "Enviando…" : "Enviar a revisión"}
                          </Button>
                        </div>
                      </form>
                    </DialogContent>
                  </Dialog>
                )}
              </div>
              {current && !submitted && !reviewAvailable && (
                <p role="status" className="text-sm text-muted-foreground">
                  Esta versión no está disponible para revisión. Comprueba tus
                  permisos sobre el conocimiento seleccionado.
                </p>
              )}
            </>
          ) : (
            <div className="flex min-h-44 flex-1 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-6 text-center">
              <PackageOpenIcon
                className="size-12 text-muted-foreground/60"
                strokeWidth={1.5}
                aria-hidden="true"
              />
              <p className="font-medium">Aún no hay una versión preparada.</p>
              <p className="max-w-64 text-sm text-muted-foreground">
                Prepara la primera versión desde Nueva versión.
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function AgentWorkflow({
  gmail,
  drive,
  workspaceId,
  data,
  collections,
  save,
  prepare,
  preview,
  submit,
}: {
  gmail?: GmailState
  drive?: DriveState
  workspaceId?: string
  data: AgentView
  collections: WorkspaceView["collections"]
  save: (values: FormData) => Promise<FormResult>
  prepare: (values: FormData) => Promise<FormResult>
  preview: (values: FormData) => Promise<FormResult>
  submit: (values: FormData) => Promise<FormResult>
}) {
  const router = useRouter()
  const form = useForm<DraftFormValues>({
    resolver: zodResolver(draftEditorForm),
    mode: "onChange",
    defaultValues: {
      content: data.draft.content,
      collectionIds: data.draft.requestedAccess.collectionIds,
      tools: data.draft.requestedAccess.tools,
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
  const [working, setWorking] = useState<
    "prepare" | "preview" | "submit" | null
  >(null)
  const [refreshing, startRefresh] = useTransition()
  const [message, setMessage] = useState("")
  const busy = !!working || refreshing
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
          tools: data.draft.requestedAccess.tools,
        })
    )
      return
    mutationLock.current = true
    setWorking(kind)
    setMessage("")
    try {
      const action =
        kind === "submit" ? submit : kind === "preview" ? preview : prepare
      const result = await action(values)
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
      setWorking(null)
    }
  }
  const candidateKey = `${data.draft.revision}:${data.preparationCodeReleaseId}:${data.candidates.map((c) => `${c.id}:${c.canSubmit}:${c.canPreview}`).join(":")}:${base.submittedCandidateIds.join(":")}`
  return (
    <>
      <DraftEditor
        gmail={gmail}
        drive={drive}
        workspaceId={workspaceId}
        agentId={data.agent.id}
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
      <VersionCards
        key={candidateKey}
        base={base}
        run={run}
        message={message}
        pendingAction={working}
      />
    </>
  )
}
