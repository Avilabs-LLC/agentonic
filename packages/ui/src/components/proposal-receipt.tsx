import {
  ClipboardCheckIcon,
  FileCheck2Icon,
  ListChecksIcon,
  ReceiptTextIcon,
} from "lucide-react"
import { submissionLabels } from "@agentonic/contracts/authoring"
import type { AgentView } from "@agentonic/contracts/authoring"
import {
  reviewFlowLabels,
  type ReviewPreparation,
} from "@agentonic/contracts/review-flow"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { EvaluationSummary } from "@workspace/ui/components/review-result-status"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import { SubmissionStatusBadge } from "@workspace/ui/components/status-badge"
import {
  ReceiptCriteria,
  ReceiptResults,
  ReceiptTextFrame,
} from "@workspace/ui/components/review-receipt-content"

const usd = (value: number) =>
  `USD ${value.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`

export function ProposalReceipt({
  submission,
  record,
  agentName,
  versionNumber,
}: {
  submission: AgentView["submissions"][number]
  record?: ReviewPreparation
  agentName: string
  versionNumber?: number
}) {
  const confirmed = Boolean(record?.evaluationId)
  const passed =
    record?.results.filter((r) => r.outcome === "passed").length ?? 0
  return (
    <div className="space-y-6">
      <AgentSettingsCard
        title="Resumen de la versión"
        icon={<ReceiptTextIcon />}
        description="Consulta el estado y lo registrado durante la revisión de tu propuesta."
      >
        <dl className="grid gap-5 text-sm sm:grid-cols-3">
          {[
            ["Agente", agentName],
            [
              "Versión",
              versionNumber ?? record?.versionNumber ?? "No disponible",
            ],
            [
              "Estado",
              <SubmissionStatusBadge key="state" status={submission.status} />,
            ],
            ...(record
              ? [
                  ["Límite autorizado", usd(record.budgetUsd)],
                  [
                    "Uso del presupuesto",
                    usd(record.committedMicrousd / 1000000),
                  ],
                ]
              : []),
          ].map(([label, value]) => (
            <div key={String(label)} className="min-w-0 space-y-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium break-words">{value}</dd>
            </div>
          ))}
        </dl>
        {record && (
          <p className="mt-4 text-xs text-muted-foreground">
            El uso del presupuesto incluye consumo y reservas pendientes de
            liquidación.
          </p>
        )}
        {submission.note && (
          <div className="mt-5">
            <ReceiptTextFrame
              title="Tu nota al enviar"
              text={submission.note}
            />
          </div>
        )}
      </AgentSettingsCard>
      {record && (
        <>
          <AgentSettingsCard
            title={
              confirmed ? "Criterios confirmados" : "Situaciones propuestas"
            }
            icon={<ListChecksIcon />}
            description={
              confirmed
                ? "Las situaciones, aclaraciones y decisiones que confirmaste antes de evaluar esta versión."
                : "Situaciones guardadas durante la preparación de esta revisión."
            }
          >
            {record.criteria.length ? (
              <ReceiptCriteria
                criteria={record.criteria}
                confirmed={confirmed}
              />
            ) : (
              <CardEmptyState title="Sin situaciones disponibles">
                {["queued", "preparing"].includes(record.status)
                  ? "Las situaciones aparecerán cuando termine la preparación."
                  : "El detalle de las situaciones no está disponible con la autorización actual."}
              </CardEmptyState>
            )}
          </AgentSettingsCard>
          <AgentSettingsCard
            title="Resultados de la evaluación"
            icon={<ClipboardCheckIcon />}
            description="Consulta las respuestas del agente y los controles de la plataforma."
          >
            {record.results.length ? (
              <>
                <EvaluationSummary
                  passed={passed}
                  total={record.results.length}
                  running={record.status === "evaluating"}
                />
                <ReceiptResults results={record.results} />
              </>
            ) : (
              <CardEmptyState
                title={
                  record.status === "evaluating"
                    ? "Evaluación en curso"
                    : "Sin resultados disponibles"
                }
              >
                {record.status === "evaluating"
                  ? "Los resultados aparecerán aquí a medida que termine cada pregunta."
                  : !record.evaluationId &&
                      ["queued", "preparing", "criteria_ready"].includes(
                        record.status
                      )
                    ? "Las pruebas comenzarán después de confirmar tus situaciones y autorizar la evaluación."
                    : "El informe no está disponible. Puede que la evaluación no haya terminado o que el acceso a sus resultados ya no esté vigente."}
              </CardEmptyState>
            )}
          </AgentSettingsCard>
        </>
      )}
      <AgentSettingsCard
        title="Estado de la revisión"
        icon={<FileCheck2Icon />}
        description="Resultado de la revisión y comentarios registrados para esta propuesta."
      >
        <div className="space-y-4">
          {record && !["approved", "needs_changes"].includes(record.status) && (
            <p className="text-sm font-medium">
              {reviewFlowLabels[record.status]}
            </p>
          )}
          {record?.summary && (
            <p className="text-sm leading-relaxed text-muted-foreground">
              {record.summary}
            </p>
          )}
          {submission.decisions.map((decision) => (
            <div key={decision.number} className="space-y-3 border-t pt-4">
              {submission.decisions.length > 1 && (
                <p className="text-sm font-medium">
                  {submissionLabels[decision.decision]}
                </p>
              )}
              {decision.feedback && (
                <ReceiptTextFrame
                  title="Comentarios del equipo"
                  text={decision.feedback}
                />
              )}
            </div>
          ))}
          {!record && !submission.decisions.length && (
            <CardEmptyState title="Sin decisión registrada">
              Todavía no se ha registrado una decisión para esta propuesta.
            </CardEmptyState>
          )}
          {submission.status === "approved" && !record?.summary && (
            <p className="text-xs text-muted-foreground">
              La aprobación de esta versión no activa un despliegue.
            </p>
          )}
        </div>
      </AgentSettingsCard>
    </div>
  )
}
