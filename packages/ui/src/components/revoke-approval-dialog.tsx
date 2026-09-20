"use client"
import { useId } from "react"
import { useRouter } from "next/navigation"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import type { FormResult } from "@agentonic/contracts/authoring"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import { Field, FieldLabel, FieldError } from "@workspace/ui/components/field"
import { Textarea } from "@workspace/ui/components/textarea"
import { Button } from "@workspace/ui/components/button"
import { notify } from "@workspace/ui/lib/toast"
const schema = z.object({
  feedback: z
    .string()
    .trim()
    .min(10, "Explica el motivo en al menos 10 caracteres.")
    .max(2000, "Usa como máximo 2000 caracteres."),
})
export function RevokeApprovalDialog({
  name,
  onClose,
  action,
}: {
  name: string
  onClose: () => void
  action: (feedback: string) => Promise<FormResult>
}) {
  const id = useId(),
    router = useRouter()
  const {
    register,
    handleSubmit,
    formState: { isValid, isSubmitting, errors },
  } = useForm({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: { feedback: "" },
  })
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revocar aprobación</DialogTitle>
          <DialogDescription>
            La aprobación de {name} dejará de ser válida. El motivo quedará
            registrado en la revisión.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={handleSubmit(async ({ feedback }) => {
            try {
              const result = await action(feedback)
              if (result.ok) {
                notify.success(result.message)
                onClose()
                router.refresh()
              } else notify.destructive(result.message)
            } catch {
              notify.destructive("No se pudo revocar la aprobación.")
            }
          })}
        >
          <Field>
            <FieldLabel htmlFor={id}>Motivo</FieldLabel>
            <Textarea
              id={id}
              disabled={isSubmitting}
              {...register("feedback")}
            />
            <FieldError errors={[errors.feedback]} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={onClose}
            >
              Cancelar
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={!isValid || isSubmitting}
            >
              {isSubmitting ? "Revocando…" : "Revocar aprobación"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
