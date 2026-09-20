"use client"
import { useId } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import { Textarea } from "@workspace/ui/components/textarea"
import { Button } from "@workspace/ui/components/button"

export type SkillValues = { name: string; instructions: string }
export function SkillEditorDialog({
  initial,
  names,
  onClose,
  onApply,
}: {
  initial?: SkillValues
  names: string[]
  onClose: () => void
  onApply: (values: SkillValues) => void
}) {
  const id = useId()
  const schema = z.object({
    name: z
      .string()
      .min(1, "Escribe un nombre.")
      .max(80, "Usa hasta 80 caracteres.")
      .regex(
        /^[a-z0-9]+(-[a-z0-9]+)*$/,
        "Usa letras minúsculas, números y guiones, sin espacios."
      )
      .refine(
        (name) => !names.includes(name),
        "Ya existe una habilidad con este nombre."
      ),
    instructions: z
      .string()
      .trim()
      .min(1, "Escribe las instrucciones.")
      .max(16000, "Usa hasta 16.000 caracteres."),
  })
  const {
    register,
    handleSubmit,
    formState: { errors, isValid },
  } = useForm<SkillValues>({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: initial ?? { name: "", instructions: "" },
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {initial ? "Detalles de la habilidad" : "Añadir habilidad"}
          </DialogTitle>
          <DialogDescription>
            Describe un procedimiento que el agente debe seguir. Guarda el
            borrador después de aplicar los cambios.
          </DialogDescription>
        </DialogHeader>
        <form noValidate onSubmit={handleSubmit(onApply)} className="space-y-5">
          <Field data-invalid={!!errors.name}>
            <FieldLabel htmlFor={`${id}-name`}>
              Nombre de la habilidad
            </FieldLabel>
            <Input
              id={`${id}-name`}
              maxLength={80}
              placeholder="resumir-documentos"
              aria-invalid={!!errors.name}
              aria-describedby={`${id}-name-help ${id}-name-error`}
              {...register("name")}
            />
            <FieldDescription id={`${id}-name-help`}>
              Identificador único, con palabras separadas por guiones.
            </FieldDescription>
            <FieldError id={`${id}-name-error`} errors={[errors.name]} />
          </Field>
          <Field data-invalid={!!errors.instructions}>
            <FieldLabel htmlFor={`${id}-instructions`}>
              Instrucciones
            </FieldLabel>
            <Textarea
              id={`${id}-instructions`}
              className="min-h-56"
              maxLength={16000}
              aria-invalid={!!errors.instructions}
              aria-describedby={`${id}-instructions-error`}
              {...register("instructions")}
            />
            <FieldError
              id={`${id}-instructions-error`}
              errors={[errors.instructions]}
            />
          </Field>
          <div className="flex justify-end gap-2 border-t pt-4">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancelar
            </Button>
            <Button type="submit" disabled={!isValid}>
              {initial ? "Aplicar cambios" : "Añadir al borrador"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
