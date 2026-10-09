"use client"
import { useId } from "react"
import { useRouter } from "next/navigation"
import { Controller, useForm, useWatch } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import {
  reviewStateChange,
  submissionLabels,
  type FormResult,
} from "@agentonic/contracts/authoring"
import { proposalDescriptor } from "@agentonic/contracts/proposals"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { Textarea } from "@workspace/ui/components/textarea"
import { Button } from "@workspace/ui/components/button"
import { notify } from "@workspace/ui/lib/toast"

// Cambiar estado in Revisiones: only the changes the database allows for this
// review, each with a comment the client reads. Recording a decision, as on
// the review page, opens the review; revoking an approval needs no access.
export type ReviewStateTarget =
  "in_review" | "changes_requested" | "rejected" | "revoked"
type Review = {
  id: string
  workspaceId: string
  agentName: string
  versionNumber: number
  number: number
  status: string
  canOpen: boolean
  canDecide: boolean
}
/** The states this review can move to, or why it cannot change now. */
export function reviewStateTargets(
  review: Review,
  canRevoke: boolean
): { targets: ReviewStateTarget[] } | { reason: string } {
  if (review.status === "approved")
    return canRevoke
      ? { targets: ["revoked"] }
      : { reason: "Revocar requiere el rol de Administración u Operación" }
  if (!["submitted", "in_review"].includes(review.status))
    return { reason: "Revisión cerrada" }
  if (!review.canOpen) return { reason: "Sin autorización vigente del cliente" }
  if (!review.canDecide)
    return {
      reason:
        "Disponible cuando el cliente confirme los criterios y termine la evaluación",
    }
  return {
    targets: [
      ...(review.status === "submitted" ? (["in_review"] as const) : []),
      "changes_requested",
      "rejected",
    ],
  }
}
const labels: Record<ReviewStateTarget, string> = {
  in_review: submissionLabels.in_review!,
  changes_requested: submissionLabels.changes_requested!,
  rejected: submissionLabels.rejected!,
  revoked: submissionLabels.revoked!,
}
const submitLabels: Record<ReviewStateTarget, [string, string]> = {
  in_review: ["Cambiar estado", "Cambiando…"],
  changes_requested: ["Solicitar cambios", "Solicitando…"],
  rejected: ["Rechazar propuesta", "Rechazando…"],
  revoked: ["Revocar aprobación", "Revocando…"],
}
const schema = z.object({
  target: z.enum(["in_review", "changes_requested", "rejected", "revoked"]),
  feedback: reviewStateChange.shape.feedback,
})

export function ChangeReviewStateDialog({
  review,
  targets,
  onClose,
  changeState,
  revokeApproval,
}: {
  review: Review
  targets: ReviewStateTarget[]
  onClose: () => void
  changeState: (
    workspaceId: string,
    submissionId: string,
    decision: string,
    feedback: string
  ) => Promise<FormResult>
  revokeApproval?: (
    workspaceId: string,
    submissionId: string,
    feedback: string
  ) => Promise<FormResult>
}) {
  const stateId = useId(),
    feedbackId = useId(),
    router = useRouter()
  const {
    control,
    register,
    handleSubmit,
    formState: { isValid, isSubmitting, errors },
  } = useForm({
    resolver: zodResolver(schema),
    mode: "onChange",
    defaultValues: { target: targets[0]!, feedback: "" },
  })
  const target = useWatch({ control, name: "target" })
  const [label, pendingLabel] = submitLabels[target]
  const items = Object.fromEntries(targets.map((t) => [t, labels[t]]))
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSubmitting) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cambiar estado</DialogTitle>
          <DialogDescription>
            {review.agentName} ·{" "}
            {proposalDescriptor(review.versionNumber, review.number)}.{" "}
            {target === "revoked"
              ? "La aprobación dejará de ser válida."
              : "Registrar el cambio cuenta como un acceso de revisión."}{" "}
            El comentario quedará registrado y el cliente lo verá.
          </DialogDescription>
        </DialogHeader>
        <form
          noValidate
          onSubmit={handleSubmit(async ({ target, feedback }) => {
            try {
              const result =
                target === "revoked"
                  ? await revokeApproval!(
                      review.workspaceId,
                      review.id,
                      feedback
                    )
                  : await changeState(
                      review.workspaceId,
                      review.id,
                      target,
                      feedback
                    )
              if (result.ok) {
                notify.success(result.message)
                onClose()
                router.refresh()
              } else notify.destructive(result.message)
            } catch {
              notify.destructive("No se pudo cambiar el estado.")
            }
          })}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={stateId}>Nuevo estado</FieldLabel>
              <Controller
                control={control}
                name="target"
                render={({ field }) => (
                  <Select
                    items={items}
                    value={field.value}
                    disabled={isSubmitting || targets.length === 1}
                    onValueChange={(value) => {
                      if (value && value !== field.value) field.onChange(value)
                    }}
                  >
                    <SelectTrigger id={stateId} className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {targets.map((t) => (
                        <SelectItem key={t} value={t}>
                          {labels[t]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
            </Field>
            <Field data-invalid={Boolean(errors.feedback)}>
              <FieldLabel htmlFor={feedbackId}>
                Comentario al cliente
              </FieldLabel>
              <Textarea
                id={feedbackId}
                disabled={isSubmitting}
                aria-invalid={Boolean(errors.feedback)}
                placeholder="Explica el motivo y los próximos pasos."
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
                variant={
                  ["rejected", "revoked"].includes(target)
                    ? "destructive"
                    : "default"
                }
                disabled={!isValid || isSubmitting}
              >
                {isSubmitting ? pendingLabel : label}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  )
}
