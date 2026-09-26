"use client"
import { CriterionStatus } from "@workspace/ui/components/status-badge"
import { LoaderCircleIcon } from "lucide-react"
import {
  criterionWasEdited,
  type ReviewCriterion,
  type ReviewPreparation,
} from "@agentonic/contracts/review-flow"
import { ProposalDialogHeader } from "@workspace/ui/components/proposal-dialog-header"
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@workspace/ui/components/table"
import { Button } from "@workspace/ui/components/button"
import { ConsentCheckbox } from "@workspace/ui/components/consent-checkbox"
export function ReviewCriteriaSummary({
  record,
  revision,
  criteria,
  consent,
  onConsent,
  pending,
  canConfirm,
  confirmed = false,
  onConfirm,
  onReview,
}: {
  record: ReviewPreparation
  revision: number
  criteria: ReviewCriterion[]
  consent: boolean
  onConsent: (checked: boolean) => void
  pending: boolean
  canConfirm: boolean
  confirmed?: boolean
  onConfirm: () => void
  onReview: (index: number) => void
}) {
  return (
    <>
      <ProposalDialogHeader
        section="Criterios"
        agentName={record.agentName}
        version={record.versionNumber}
        revision={revision}
      />
      <div className="min-h-0 space-y-6 overflow-y-auto">
        <Table
          aria-label="Resumen de situaciones"
          className="min-w-[520px] table-fixed [&_td]:py-3"
        >
          <TableHeader>
            <TableRow>
              <TableHead>Situación</TableHead>
              <TableHead>Editados</TableHead>
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
                  <TableCell className="whitespace-normal">
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
                    <CriterionStatus criterion={c} confirmed={confirmed} />
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
        {confirmed ? (
          <p className="text-sm text-muted-foreground">
            Criterios confirmados. Puedes abrir una situación para ajustarla.
          </p>
        ) : (
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
              Confirmo estas situaciones y el comportamiento esperado del
              agente.
            </ConsentCheckbox>
            <Button
              type="submit"
              disabled={!consent || !canConfirm || pending}
              aria-busy={pending}
            >
              {pending && (
                <LoaderCircleIcon className="animate-spin" aria-hidden="true" />
              )}
              Confirmar criterios
            </Button>
          </form>
        )}
      </div>
    </>
  )
}
