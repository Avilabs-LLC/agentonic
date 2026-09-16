import { ChevronDownIcon } from "lucide-react"
import type { ReviewReceipt } from "@agentonic/contracts/review-receipt"
import { criterionDecisionLabel } from "@agentonic/contracts/review-flow"
import { Badge } from "@workspace/ui/components/badge"

export function ReceiptTextFrame({
  title,
  text,
  tone = "muted",
}: {
  title: string
  text: string
  tone?: "blue" | "green" | "muted"
}) {
  return (
    <div
      className={`space-y-2 rounded-lg border p-4 ${tone === "blue" ? "border-blue-200 bg-blue-50/60 dark:border-blue-400/25 dark:bg-blue-400/5" : tone === "green" ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-400/25 dark:bg-emerald-400/5" : "bg-muted/20"}`}
    >
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
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium">
            <span className="min-w-0 flex-1 break-words">
              Situación {i + 1}: {c.question}
            </span>
            <Badge
              className="shrink-0"
              variant={
                c.excluded
                  ? "warning"
                  : c.reviewDecision === "approved" || confirmed
                    ? "success"
                    : "slate"
              }
            >
              {criterionDecisionLabel(c, confirmed)}
            </Badge>
            <ChevronDownIcon
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="mt-4 space-y-4">
            <ReceiptTextFrame
              title="Mensaje al agente"
              text={c.question}
              tone="blue"
            />
            <ReceiptTextFrame
              title="Respuesta o comportamiento esperado"
              text={c.expectedAnswer || "Sin respuesta esperada."}
              tone="green"
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
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium">
            <span className="min-w-0 flex-1 break-words">
              {result.kind === "platform"
                ? "Control de plataforma"
                : "Situación"}{" "}
              {i + 1}: {result.question}
            </span>
            <Badge
              className="shrink-0"
              variant={result.outcome === "passed" ? "success" : "warning"}
            >
              {result.outcome === "passed"
                ? "Superada"
                : result.outcome === "failed"
                  ? "No superada"
                  : "Requiere atención"}
            </Badge>
            <ChevronDownIcon
              aria-hidden="true"
              className="size-4 shrink-0 transition-transform group-open:rotate-180"
            />
          </summary>
          <div className="mt-4 space-y-4">
            <ReceiptTextFrame
              title="Respuesta esperada"
              text={
                result.expectedAnswer || "Sin respuesta esperada registrada."
              }
              tone="blue"
            />
            <ReceiptTextFrame
              title="Respuesta del agente"
              text={result.answer || "Sin respuesta registrada."}
              tone="green"
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
