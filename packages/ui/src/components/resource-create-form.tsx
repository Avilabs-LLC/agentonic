"use client"
import { useId, useState } from "react"
import { useRouter } from "next/navigation"
import { Controller, useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import type { FormResult } from "@agentonic/contracts/authoring"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Field,
  FieldLabel,
  FieldError,
  FieldDescription,
} from "@workspace/ui/components/field"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@workspace/ui/components/select"
import { notify } from "@workspace/ui/lib/toast"
const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Escribe un nombre.")
    .max(120, "Usa hasta 120 caracteres."),
  slug: z
    .string()
    .min(1, "Escribe un identificador.")
    .max(100, "Usa hasta 100 caracteres.")
    .regex(
      /^[a-z0-9]+(-[a-z0-9]+)*$/,
      "Usa letras minúsculas, números y guiones, sin espacios."
    ),
  description: z.string().trim().max(2000, "Usa hasta 2000 caracteres."),
  templateVersionId: z.string(),
})
export type CreationTemplate = { id: string; name: string; version: string }
export function ResourceCreateForm({
  action,
  templates,
  disabled = false,
  onSuccess,
  onPendingChange,
  onCancel,
}: {
  action: (data: FormData) => Promise<FormResult>
  templates?: CreationTemplate[]
  disabled?: boolean
  onSuccess?: () => void
  onPendingChange?: (pending: boolean) => void
  onCancel?: () => void
}) {
  const id = useId()
  const router = useRouter()
  const [message, setMessage] = useState("")
  const [interrupted, setInterrupted] = useState(false)
  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isValid, isSubmitting },
  } = useForm<z.infer<typeof schema>>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: {
      name: "",
      slug: "",
      description: "",
      templateVersionId: templates?.[0]?.id ?? "",
    },
  })
  const isAgent = templates !== undefined
  async function submit(values: z.infer<typeof schema>) {
    setMessage("")
    setInterrupted(false)
    onPendingChange?.(true)
    try {
      const data = new FormData()
      Object.entries(values).forEach(([key, value]) => data.set(key, value))
      const result = await action(data)
      if (!result.ok) {
        setMessage(result.message)
        notify.destructive(result.message)
        return
      }
      notify.success(result.message)
      reset()
      onSuccess?.()
      if (result.href) router.push(result.href)
      else router.refresh()
    } catch {
      const text =
        "No se pudo confirmar la acción. Conservamos tus campos. Copia tus cambios y recarga para comprobar si se guardó antes de volver a intentarlo."
      setMessage(text)
      setInterrupted(true)
      notify.destructive(text)
    } finally {
      onPendingChange?.(false)
    }
  }
  return (
    <form onSubmit={handleSubmit(submit)} noValidate className="space-y-4">
      <fieldset disabled={disabled || isSubmitting} className="space-y-4">
        <Field data-invalid={Boolean(errors.name)}>
          <FieldLabel htmlFor={`${id}-name`}>Nombre</FieldLabel>
          <Input
            id={`${id}-name`}
            maxLength={120}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? `${id}-name-error` : undefined}
            {...register("name")}
          />
          <FieldError id={`${id}-name-error`} errors={[errors.name]} />
        </Field>
        <Field data-invalid={Boolean(errors.slug)}>
          <FieldLabel htmlFor={`${id}-slug`}>Identificador</FieldLabel>
          <Input
            id={`${id}-slug`}
            maxLength={100}
            placeholder={
              isAgent ? "asistente-de-proyectos" : "manuales-del-equipo"
            }
            aria-invalid={Boolean(errors.slug)}
            aria-describedby={`${id}-slug-help ${id}-slug-error`}
            {...register("slug")}
          />
          <FieldDescription id={`${id}-slug-help`}>
            Usa letras minúsculas, números y guiones.
          </FieldDescription>
          <FieldError id={`${id}-slug-error`} errors={[errors.slug]} />
        </Field>
        {isAgent && (
          <>
            <Field data-invalid={Boolean(errors.description)}>
              <FieldLabel htmlFor={`${id}-description`}>Descripción</FieldLabel>
              <Textarea
                id={`${id}-description`}
                maxLength={2000}
                {...register("description")}
              />
              <FieldError errors={[errors.description]} />
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-template`}>Plantilla</FieldLabel>
              <Controller
                name="templateVersionId"
                control={control}
                render={({ field }) => (
                  <Select
                    name={field.name}
                    value={field.value}
                    onValueChange={(value) => field.onChange(value ?? "")}
                    items={templates.map((t) => ({
                      value: t.id,
                      label: `${t.name} · ${t.version}`,
                    }))}
                  >
                    <SelectTrigger id={`${id}-template`} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {templates.map((t) => (
                        <SelectItem key={t.id} value={t.id}>
                          {t.name} · {t.version}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
          </>
        )}
      </fieldset>
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      {interrupted && (
        <Button
          type="button"
          variant="outline"
          onClick={() => window.location.reload()}
        >
          Ya copié mis cambios: recargar
        </Button>
      )}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button
            type="button"
            variant="outline"
            disabled={isSubmitting}
            onClick={onCancel}
          >
            Cancelar
          </Button>
        )}
        <Button
          type="submit"
          disabled={
            disabled ||
            !isValid ||
            isSubmitting ||
            (isAgent && !templates.length)
          }
        >
          {isSubmitting
            ? "Creando…"
            : isAgent
              ? "Crear agente"
              : "Crear colección"}
        </Button>
      </div>
    </form>
  )
}
