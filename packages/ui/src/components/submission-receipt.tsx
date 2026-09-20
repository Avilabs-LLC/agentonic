import { ApprovedModelResults } from "@workspace/ui/components/model-evaluation-dialog"
import { approvalLabels } from "@agentonic/contracts/lifecycle"
import {
  ClipboardCheckIcon,
  FileCheck2Icon,
  ListChecksIcon,
  ReceiptTextIcon,
} from "lucide-react"
import type { ReviewReceipt } from "@agentonic/contracts/review-receipt"
import { SubmissionVersionContent } from "@workspace/ui/components/submission-review-layout"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { BackRow, RecordHeader } from "@workspace/ui/components/record-header"
import { EvaluationSummary } from "@workspace/ui/components/review-result-status"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"

import {
  ReceiptTextFrame,
  ReceiptCriteria,
  ReceiptResults,
} from "@workspace/ui/components/review-receipt-content"

export function SubmissionReceipt({
  receipt: r,
  backHref,
}: {
  receipt: ReviewReceipt
  backHref: string
}) {
  const date = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat("es-VE", {
          dateStyle: "medium",
          timeStyle: "short",
          timeZone: r.timezone,
        }).format(new Date(value))
      : "No disponible"
  const usd = (value: number) =>
    `USD ${value.toLocaleString("es-VE", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <BackRow href={backHref} />
      <RecordHeader
        title={r.agentName}
        description={`Versión ${r.versionNumber} · Revisión ${r.number} · Comprobante de aprobación.`}
      />
      <AgentSettingsCard
        title="Resumen de la versión"
        icon={<ReceiptTextIcon />}
        description="Contenido y resultados de la versión enviada. Este comprobante no representa un despliegue."
      >
        <dl className="grid gap-5 text-sm sm:grid-cols-2">
          {[
            ["Espacio de trabajo", r.workspaceName],
            ["Enviada", date(r.submittedAt)],
            ["Criterios confirmados", date(r.evaluation.confirmedAt)],
            ["Evaluación terminada", date(r.evaluation.finishedAt)],
            ["Límite autorizado", usd(r.evaluation.budgetUsd)],
            [
              "Uso del presupuesto",
              usd(r.evaluation.committedMicrousd / 1000000),
            ],
          ].map(([label, value]) => (
            <div key={label} className="space-y-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">
          Fechas en {r.timezone}. El uso del presupuesto incluye consumo y
          reservas pendientes de liquidación.
        </p>
        {r.note && (
          <div className="mt-5">
            <ReceiptTextFrame title="Nota del cliente" text={r.note} />
          </div>
        )}
      </AgentSettingsCard>
      {r.contentAvailable && r.content ? (
        <SubmissionVersionContent
          content={r.content}
          collectionCount={r.collections.length}
          tools={r.tools}
          collectionNames={r.collections.map((c) => c.name)}
        />
      ) : (
        <AgentSettingsCard
          title="Contenido de la versión"
          icon={<FileCheck2Icon />}
          description="El comprobante conserva los datos de la aprobación."
        >
          <CardEmptyState title="Contenido no disponible">
            La autorización para consultar el contenido privado ya no está
            vigente.
          </CardEmptyState>
        </AgentSettingsCard>
      )}
      <AgentSettingsCard
        title="Criterios confirmados"
        icon={<ListChecksIcon />}
        description="Las situaciones y decisiones que el cliente confirmó antes de evaluar esta versión."
      >
        {!r.reportAvailable ? (
          <CardEmptyState title="Criterios no disponibles">
            Los criterios privados ya no están disponibles con la autorización
            actual.
          </CardEmptyState>
        ) : r.criteria.length ? (
          <ReceiptCriteria criteria={r.criteria} />
        ) : (
          <CardEmptyState title="Sin criterios individuales">
            Esta evaluación anterior no registra decisiones individuales del
            cliente. Los casos ejecutados se muestran en los resultados.
          </CardEmptyState>
        )}
      </AgentSettingsCard>
      <AgentSettingsCard
        title="Resultados de la evaluación"
        icon={<ClipboardCheckIcon />}
        description="Respuestas y verificaciones de la evaluación que respaldó esta aprobación."
      >
        {!r.reportAvailable ? (
          <CardEmptyState title="Resultados no disponibles">
            El detalle de las respuestas ya no está disponible por los límites
            de autorización o conservación de la evidencia.
          </CardEmptyState>
        ) : r.modelBatch ? (
          <ApprovedModelResults
            agentName={r.agentName}
            batch={r.modelBatch}
            versionNumber={r.versionNumber}
            history={r.reviewBatches}
            currentRevision={r.currentCriteriaRevision}
            totalCommittedMicrousd={r.totalCommittedMicrousd}
          />
        ) : (
          <>
            <EvaluationSummary
              passed={
                r.results.filter((result) => result.outcome === "passed").length
              }
              total={r.results.length}
            />
            <ReceiptResults results={r.results} />
          </>
        )}
      </AgentSettingsCard>
      <AgentSettingsCard
        title="Aprobación registrada"
        icon={<FileCheck2Icon />}
        description="Decisión vinculada a esta versión y a su evaluación."
      >
        <dl className="grid gap-5 text-sm sm:grid-cols-2">
          {[
            [
              "Vigencia",
              r.approval.reason
                ? approvalLabels[r.approval.reason]
                : r.approval.valid
                  ? "Vigente"
                  : "No vigente",
            ],
            [
              "Tipo de aprobación",
              r.approval.automatic ? "Automática" : "Revisión del equipo",
            ],
            [
              "Responsable",
              r.approval.automatic
                ? "Política de aprobación de la plataforma"
                : (r.approval.reviewerName ?? "Personal del equipo"),
            ],
            ["Aprobada", date(r.approval.createdAt)],
            ["Válida hasta", date(r.approval.expiresAt)],
          ].map(([label, value]) => (
            <div key={label} className="space-y-1">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        {!r.approval.valid && (
          <p className="mt-5 text-sm text-muted-foreground">
            Esta versión conserva su aprobación histórica. Para activarla,
            renueva la revisión desde la sección de aprobación y activación.
          </p>
        )}
        {r.approval.feedback && (
          <div className="mt-5">
            <ReceiptTextFrame
              title="Comentarios de la aprobación"
              text={r.approval.feedback}
            />
          </div>
        )}
        <details className="mt-5 border-t pt-4">
          <summary className="cursor-pointer text-sm font-medium">
            Identificadores del comprobante
          </summary>
          <dl className="mt-4 space-y-3 text-xs">
            {[
              ["Aprobación", r.approval.id],
              ["Evaluación", r.evaluation.id],
              ["Huella de la configuración", r.configurationHash],
              ["Huella de la evidencia", r.evaluation.evidenceHash],
            ].map(([label, value]) => (
              <div key={label} className="space-y-1">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="font-mono break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      </AgentSettingsCard>
    </div>
  )
}
