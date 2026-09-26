import { ClipboardCheckIcon, ListChecksIcon } from "lucide-react"
import { type ReviewPreparation } from "@agentonic/contracts/review-flow"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { EvaluationSummary } from "@workspace/ui/components/review-result-status"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import {
  ReceiptCriteria,
  ReceiptResults,
} from "@workspace/ui/components/review-receipt-content"

const usd = (value: number) =>
  `USD ${value.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`

export function ProposalReceipt({ record }: { record: ReviewPreparation }) {
  const confirmed = Boolean(record.evaluationId)
  const passed = record.results.filter((r) => r.outcome === "passed").length
  return (
    <div className="space-y-6">
      <div className="space-y-2 rounded-lg border p-4 text-sm">
        <dl className="grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Límite autorizado</dt>
            <dd className="font-medium">{usd(record.budgetUsd)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">
              Consumo y reservas pendientes
            </dt>
            <dd className="font-medium">
              {usd(record.committedMicrousd / 1000000)}
            </dd>
          </div>
        </dl>
      </div>
      {record.summary && (
        <p className="text-sm text-muted-foreground">{record.summary}</p>
      )}
      <AgentSettingsCard
        title={confirmed ? "Criterios confirmados" : "Situaciones propuestas"}
        icon={<ListChecksIcon />}
        description={
          confirmed
            ? "Las situaciones, aclaraciones y decisiones que confirmaste antes de evaluar esta versión."
            : "Situaciones guardadas durante la preparación de esta revisión."
        }
      >
        {record.criteria.length ? (
          <ReceiptCriteria criteria={record.criteria} confirmed={confirmed} />
        ) : (
          <CardEmptyState title="Sin situaciones disponibles">
            {["queued", "preparing"].includes(record.status)
              ? "Las situaciones aparecerán cuando termine la preparación."
              : "El detalle de las situaciones no está disponible con la autorización actual."}
          </CardEmptyState>
        )}
      </AgentSettingsCard>
      {record.evaluationId && (
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
                : "El informe no está disponible. Puede que la evaluación no haya terminado o que el acceso a sus resultados ya no esté vigente."}
            </CardEmptyState>
          )}
        </AgentSettingsCard>
      )}
    </div>
  )
}
