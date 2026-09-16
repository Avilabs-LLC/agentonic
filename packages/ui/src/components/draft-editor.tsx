"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { useWatch, type UseFormReturn } from "react-hook-form"
import {
  CheckIcon,
  PlusIcon,
  ScrollTextIcon,
  ListChecksIcon,
  LibraryBigIcon,
} from "lucide-react"
import {
  SYSTEM_PROMPT_MIN_CHARACTERS,
  systemPromptCharacterCount,
  systemPromptMinimumMessage,
  type AgentView,
  type WorkspaceView,
  type FormResult,
} from "@agentonic/contracts/authoring"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { AgentAssetList } from "@workspace/ui/components/agent-asset-list"
import { AgentCapabilityPlaceholder } from "@workspace/ui/components/agent-capability-placeholder"
import { SkillEditorDialog } from "@workspace/ui/components/skill-editor-dialog"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@workspace/ui/components/field"
import { Button } from "@workspace/ui/components/button"
import { Checkbox } from "@base-ui/react/checkbox"
import type { DraftFormValues as Values } from "@agentonic/contracts/workflow"
import { notify } from "@workspace/ui/lib/toast"

export function DraftEditor({
  draft,
  collections,
  action,
  disabled = false,
  form,
  onEditingSkillChange,
}: {
  draft: AgentView["draft"]
  collections: WorkspaceView["collections"]
  action: (data: FormData) => Promise<FormResult>
  disabled?: boolean
  form: UseFormReturn<Values>
  onEditingSkillChange: (editing: boolean) => void
}) {
  const router = useRouter()
  const [editing, setEditingState] = useState<number | "new" | null>(null)
  const [message, setMessage] = useState("")
  const {
    register,
    control,
    handleSubmit,
    setValue,
    formState: { errors, isValid, isSubmitting, isDirty },
  } = form
  function setEditing(value: number | "new" | null) {
    setEditingState(value)
    onEditingSkillChange(value !== null)
  }
  const skills = useWatch({ control, name: "content.skills" })
  const prompt = useWatch({ control, name: "content.systemPrompt" })
  const promptError =
    errors.content?.systemPrompt ??
    (prompt.length > 0 &&
    systemPromptCharacterCount(prompt) < SYSTEM_PROMPT_MIN_CHARACTERS
      ? { message: systemPromptMinimumMessage }
      : undefined)
  const collectionIds = useWatch({ control, name: "collectionIds" })
  const updateSkills = (values: Values["content"]["skills"]) =>
    setValue("content.skills", values, {
      shouldDirty: true,
      shouldValidate: true,
    })
  async function submit(values: Values) {
    if (disabled || editing !== null) return
    setMessage("")
    const data = new FormData()
    data.set("revision", String(draft.revision))
    data.set("systemPrompt", values.content.systemPrompt)
    values.content.skills.forEach((skill) => {
      data.append("skillName", skill.name)
      data.append("skillInstructions", skill.instructions)
    })
    values.collectionIds.forEach((id) => data.append("collections", id))
    try {
      const result = await action(data)
      if (!result.ok) {
        setMessage(result.message)
        notify.destructive(result.message)
        return
      }
      notify.success(result.message)
      router.refresh()
    } catch {
      const text =
        "No se pudo confirmar el guardado. Copia tus cambios antes de recargar; siguen en el formulario."
      setMessage(text)
      notify.destructive(text)
    }
  }
  return (
    <>
      <form
        noValidate
        onSubmit={handleSubmit(submit)}
        className="min-w-0 space-y-6"
      >
        <fieldset
          disabled={disabled || isSubmitting}
          className="min-w-0 space-y-6"
        >
          <AgentSettingsCard
            title="Instrucciones del sistema"
            icon={<ScrollTextIcon />}
            description="Dale a tu agente un propósito, una voz y una forma de trabajar."
            footer="Estas instrucciones orientan al agente; no conceden permisos ni reemplazan las reglas de seguridad."
          >
            <Field data-invalid={!!promptError}>
              <FieldLabel htmlFor="systemPrompt">Instrucciones</FieldLabel>
              <Textarea
                id="systemPrompt"
                maxLength={32000}
                className="min-h-52 text-sm leading-relaxed"
                placeholder="Explica qué debe hacer tu agente, cómo debe responder y qué límites debe respetar…"
                aria-invalid={!!promptError}
                aria-describedby="system-prompt-help system-prompt-error"
                {...register("content.systemPrompt")}
              />
              <FieldDescription id="system-prompt-help">
                {systemPromptCharacterCount(prompt)} caracteres sin contar
                espacios · Mínimo {SYSTEM_PROMPT_MIN_CHARACTERS}.
              </FieldDescription>
              <FieldError id="system-prompt-error" errors={[promptError]} />
            </Field>
          </AgentSettingsCard>
          <AgentSettingsCard
            title="Habilidades"
            icon={<ListChecksIcon />}
            description="Enseña procedimientos específicos: resumir documentos, preparar informes o clasificar solicitudes."
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || skills.length >= 20 || isSubmitting}
                onClick={() => setEditing("new")}
              >
                <PlusIcon />
                Añadir habilidad
              </Button>
            }
            footer={
              <>
                <span>{skills.length} de 20 habilidades</span>
                <span>Los cambios se aplican al guardar el borrador.</span>
              </>
            }
          >
            <AgentAssetList
              label="Habilidades del borrador"
              rows={skills.map((skill, index) => ({
                id: String(index),
                name: skill.name,
                description: skill.instructions,
              }))}
              empty="Aún no hay habilidades. Añade la primera para enseñarle un procedimiento a tu agente."
              disabled={disabled || isSubmitting}
              onView={(row) => setEditing(Number(row.id))}
              onRemove={(row) => {
                updateSkills(
                  skills.filter((_, index) => index !== Number(row.id))
                )
                notify.success(
                  "Habilidad retirada del formulario. Guarda el borrador para aplicar el cambio."
                )
              }}
            />
            <FieldError errors={[errors.content?.skills]} />
          </AgentSettingsCard>
          <AgentSettingsCard
            title="Conocimiento"
            icon={<LibraryBigIcon />}
            description="Selecciona las colecciones de documentos que tu agente necesitará consultar."
            action={
              <span className="text-sm text-muted-foreground tabular-nums">
                {collectionIds.length} seleccionadas
              </span>
            }
            footer="Las colecciones seleccionadas se incluyen al preparar una versión. El acceso de producción requiere aprobación."
          >
            <Field data-invalid={!!errors.collectionIds}>
              <fieldset
                aria-describedby={
                  collectionIds.length >= 20
                    ? "agent-collections-help"
                    : undefined
                }
                className="min-w-0"
              >
                <legend className="mb-3 text-sm font-medium">
                  Colecciones
                </legend>
                <div className="max-h-80 divide-y overflow-y-auto border-t">
                  {collections.map((collection) => {
                    const checked = collectionIds.includes(collection.id)
                    const collectionDisabled =
                      disabled ||
                      isSubmitting ||
                      (!checked && collectionIds.length >= 20)
                    return (
                      <label
                        key={collection.id}
                        className="flex cursor-pointer items-center gap-3 py-4 text-sm has-disabled:cursor-not-allowed has-disabled:opacity-50"
                      >
                        <Checkbox.Root
                          checked={checked}
                          disabled={collectionDisabled}
                          onCheckedChange={(selected) =>
                            setValue(
                              "collectionIds",
                              selected
                                ? [...collectionIds, collection.id]
                                : collectionIds.filter(
                                    (id) => id !== collection.id
                                  ),
                              { shouldDirty: true, shouldValidate: true }
                            )
                          }
                          className="flex size-4 shrink-0 items-center justify-center rounded-sm border border-input outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground"
                        >
                          <Checkbox.Indicator>
                            <CheckIcon className="size-3" />
                          </Checkbox.Indicator>
                        </Checkbox.Root>
                        <span className="min-w-0 break-words">
                          {collection.name}
                        </span>
                      </label>
                    )
                  })}
                </div>
              </fieldset>
              {collectionIds.length >= 20 && (
                <FieldDescription id="agent-collections-help">
                  Has alcanzado el límite de 20 colecciones. Desmarca una para
                  elegir otra.
                </FieldDescription>
              )}
              {!collections.length && (
                <FieldDescription>
                  Crea una colección y sube documentos desde Conocimiento para
                  poder seleccionarla aquí.
                </FieldDescription>
              )}
              <FieldError errors={[errors.collectionIds]} />
            </Field>
          </AgentSettingsCard>
        </fieldset>
        <AgentCapabilityPlaceholder kind="tools" />
        <AgentCapabilityPlaceholder kind="connections" />
        <div
          className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card p-4 shadow-sm"
          aria-live="polite"
        >
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              Borrador · Revisión {draft.revision}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {isDirty ? "Cambios sin guardar." : "Sin cambios pendientes."}{" "}
              <span className="hidden sm:inline">
                Guardar no despliega el agente.
              </span>
            </p>
          </div>
          <Button
            type="submit"
            disabled={
              disabled ||
              !isValid ||
              !isDirty ||
              isSubmitting ||
              editing !== null
            }
          >
            {isSubmitting ? "Guardando…" : "Guardar borrador"}
          </Button>
          {message && (
            <p role="alert" className="w-full text-sm text-destructive">
              {message}
            </p>
          )}
        </div>
      </form>
      {editing !== null && (
        <SkillEditorDialog
          initial={typeof editing === "number" ? skills[editing] : undefined}
          names={skills
            .filter((_, index) => index !== editing)
            .map((s) => s.name)}
          onClose={() => setEditing(null)}
          onApply={(values) => {
            updateSkills(
              editing === "new"
                ? [...skills, values]
                : skills.map((skill, index) =>
                    index === editing ? values : skill
                  )
            )
            setEditing(null)
            notify.success(
              "Habilidad actualizada en el formulario. Guarda el borrador para conservarla."
            )
          }}
        />
      )}
    </>
  )
}
