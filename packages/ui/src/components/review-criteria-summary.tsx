"use client"
import { LoaderCircleIcon } from "lucide-react"
import {
  criterionWasEdited,
  type ReviewCriterion,
  type ReviewPreparation,
} from "@agentonic/contracts/review-flow"
import { DialogTitle, DialogDescription } from "@workspace/ui/components/dialog"
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@workspace/ui/components/table"
import { CriterionStatus } from "@workspace/ui/components/status-badge"
import { Button } from "@workspace/ui/components/button"
import { ConsentCheckbox } from "@workspace/ui/components/consent-checkbox"
export function ReviewCriteriaSummary({
  record,
  criteria,
  consent,
  onConsent,
  pending,
  canConfirm,
  onConfirm,
  onReview,
}: {
  record: ReviewPreparation
  criteria: ReviewCriterion[]
  consent: boolean
  onConsent: (checked: boolean) => void
  pending: boolean
  canConfirm: boolean
  onConfirm: () => void
  onReview: (index: number) => void
}) {
  return (
    <>
      <DialogTitle className="sr-only">Resumen antes de evaluar</DialogTitle>
      <DialogDescription className="sr-only">
        Revisa las situaciones y autoriza las pruebas de esta versión.
      </DialogDescription>
      <div className="min-h-0 space-y-6 overflow-y-auto">
        <dl className="flex flex-wrap gap-x-12 gap-y-4 pr-8">
          <div className="min-w-0 space-y-1">
            <dt className="text-sm text-muted-foreground">Agente</dt>
            <dd className="text-xl font-semibold tracking-tight break-words">
              {record.agentName ?? "No disponible"}
            </dd>
          </div>
          <div className="space-y-1">
            <dt className="text-sm text-muted-foreground">Versión</dt>
            <dd className="text-xl font-semibold tabular-nums">
              {record.versionNumber ?? "—"}
            </dd>
          </div>
        </dl>
        <Table
          aria-label="Resumen de situaciones"
          className="min-w-[520px] table-fixed"
        >
          <TableHeader>
            <TableRow>
              <TableHead>Situación</TableHead>
              <TableHead className="whitespace-normal">
                Mensaje o respuesta editados
              </TableHead>
              <TableHead>Aclaraciones</TableHead>
              <TableHead>Decisión</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {criteria.map((c, index) => {
              const edited = criterionWasEdited(c, record.originalCriteria)
              const added =
                record.originalCriteria &&
                !record.originalCriteria.some(
                  (original) => original.key === c.key
                )
              return (
                <TableRow key={c.key}>
                  <TableCell className="py-3 whitespace-normal">
                    <Button
                      type="button"
                      variant="link"
                      className="h-auto p-0 underline"
                      disabled={pending}
                      onClick={() => onReview(index)}
                      aria-label={`Revisar situación ${index + 1}`}
                    >
                      Situación {index + 1}
                    </Button>
                    {added && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Añadida por ti
                      </p>
                    )}
                  </TableCell>
                  <TableCell>
                    {edited === null ? "—" : edited ? "Sí" : "No"}
                  </TableCell>
                  <TableCell>{c.notes.trim() ? "Sí" : "No"}</TableCell>
                  <TableCell>
                    <CriterionStatus criterion={c} />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
        {!canConfirm && (
          <p className="text-sm text-muted-foreground">
            Debe quedar al menos una situación aprobada para evaluar. Abre una
            situación para revisar tu decisión.
          </p>
        )}
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault()
            onConfirm()
          }}
        >
          <ConsentCheckbox
            checked={consent}
            onCheckedChange={onConsent}
            disabled={pending || !canConfirm}
          >
            Confirmo estas situaciones y autorizo las pruebas dentro del límite
            total de USD{" "}
            {record.budgetUsd.toLocaleString("es-VE", {
              minimumFractionDigits: 2,
            })}
            .
          </ConsentCheckbox>
          <Button
            type="submit"
            disabled={!consent || !canConfirm || pending}
            aria-busy={pending}
          >
            {pending && (
              <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
            )}
            Confirmar criterios y evaluar
          </Button>
        </form>
      </div>
    </>
  )
}
