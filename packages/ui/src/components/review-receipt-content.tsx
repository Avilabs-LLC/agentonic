import { ChevronDownIcon } from "lucide-react"
import type { ReviewReceipt } from "@agentonic/contracts/review-receipt"
import {
  CriterionStatus,
  DomainStatus,
} from "@workspace/ui/components/status-badge"

export function ReceiptTextFrame({
  title,
  text,
}: {
  title: string
  text: string
}) {
  return (
    <div className="space-y-2 rounded-lg border bg-muted/20 p-4">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </p>
    </div>
  )
}
export function ReceiptCriteria({
  criteria,
  confirmed = true,
}: {
  criteria: ReviewReceipt["criteria"]
  confirmed?: boolean
}) {
  return (
    <div className="divide-y border-y">
      {criteria.map((c, i) => (
        <details key={c.key} className="group py-4">
          <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 text-sm font-medium sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] [&>span:nth-child(2)]:col-start-1 [&>span:nth-child(2)]:row-start-2 sm:[&>span:nth-child(2)]:col-start-2 sm:[&>span:nth-child(2)]:row-start-1">
            <span className="min-w-0 flex-1 break-words">
              Situación {i + 1}: {c.question}
            </span>
            <CriterionStatus criterion={c} confirmed={confirmed} />
            <ChevronDownIcon
              aria-hidden="true"
              className="col-start-2 row-start-1 size-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none sm:col-start-3"
            />
          </summary>
          <div className="mt-4 space-y-4">
            <ReceiptTextFrame title="Mensaje al agente" text={c.question} />
            <ReceiptTextFrame
              title="Respuesta o comportamiento esperado"
              text={c.expectedAnswer || "Sin respuesta esperada."}
            />
            {c.notes && (
              <ReceiptTextFrame title="Aclaraciones" text={c.notes} />
            )}
            {c.excluded && (
              <ReceiptTextFrame
                title="Motivo de exclusión"
                text={c.exclusionReason}
              />
            )}
            {c.basis && (
              <p className="text-sm leading-relaxed text-muted-foreground">
                <span className="font-medium">Fundamento: </span>
                {c.basis.replace(/\s+/g, " ").trim()}
              </p>
            )}
          </div>
        </details>
      ))}
    </div>
  )
}

export function ReceiptResults({
  results,
}: {
  results: Array<
    ReviewReceipt["results"][number] & {
      sources?: Array<{ id: string; text: string }>
    }
  >
}) {
  return (
    <div className="divide-y border-y">
      {results.map((result, i) => (
        <details key={result.key} className="group py-4">
          <summary className="grid cursor-pointer list-none grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 text-sm font-medium sm:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] [&>span:nth-child(2)]:col-start-1 [&>span:nth-child(2)]:row-start-2 sm:[&>span:nth-child(2)]:col-start-2 sm:[&>span:nth-child(2)]:row-start-1">
            <span className="min-w-0 flex-1 break-words">
              {result.kind === "platform"
                ? "Control de plataforma"
                : "Situación"}{" "}
              {i + 1}: {result.question}
            </span>
            <DomainStatus domain="result" status={result.outcome} />
            <ChevronDownIcon
              aria-hidden="true"
              className="col-start-2 row-start-1 size-4 shrink-0 transition-transform group-open:rotate-180 motion-reduce:transition-none sm:col-start-3"
            />
          </summary>
          <div className="mt-4 space-y-4">
            <ReceiptTextFrame
              title="Respuesta esperada"
              text={
                result.expectedAnswer || "Sin respuesta esperada registrada."
              }
            />
            <ReceiptTextFrame
              title="Respuesta del agente"
              text={result.answer || "Sin respuesta registrada."}
            />
            {result.explanation && (
              <ReceiptTextFrame
                title="Resultado de la revisión"
                text={result.explanation}
              />
            )}
            {result.suggestion && (
              <ReceiptTextFrame title="Observación" text={result.suggestion} />
            )}
            {!!result.sources?.length && (
              <details className="border-t pt-4 text-sm">
                <summary className="cursor-pointer font-medium">
                  Consultar evidencia
                </summary>
                <div className="mt-4 space-y-3">
                  {result.sources.map((source) => (
                    <blockquote
                      key={source.id}
                      className="border-l-2 pl-3 leading-relaxed break-words whitespace-pre-wrap text-muted-foreground"
                    >
                      {source.text}
                    </blockquote>
                  ))}
                </div>
              </details>
            )}
          </div>
        </details>
      ))}
    </div>
  )
}
