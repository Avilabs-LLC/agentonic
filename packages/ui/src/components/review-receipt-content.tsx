import { ChevronDownIcon, FileTextIcon } from "lucide-react"
import type { ReviewReceipt } from "@agentonic/contracts/review-receipt"
import type { EvidenceSource } from "@agentonic/contracts/review-flow"
import {
  CriterionStatus,
  DomainStatus,
} from "@workspace/ui/components/status-badge"
import { cn } from "@workspace/ui/lib/utils"

// One colour per kind of text, matching the fields of the criteria review dialog.
const tones = {
  question: { dot: "bg-primary", frame: "border-primary/30 bg-primary/5" },
  expected: {
    dot: "bg-emerald-600 dark:bg-emerald-400",
    frame:
      "border-emerald-200 bg-emerald-50/60 dark:border-emerald-400/25 dark:bg-emerald-400/5",
  },
  answer: {
    dot: "bg-sky-500 dark:bg-sky-400",
    frame:
      "border-sky-200 bg-sky-50/60 dark:border-sky-400/25 dark:bg-sky-400/5",
  },
  review: {
    dot: "bg-violet-500 dark:bg-violet-400",
    frame:
      "border-violet-200 bg-violet-50/60 dark:border-violet-400/25 dark:bg-violet-400/5",
  },
}

export function ReceiptTextFrame({
  title,
  text,
  tone,
}: {
  title: string
  text: string
  tone?: keyof typeof tones
}) {
  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border p-4",
        tone ? tones[tone].frame : "bg-muted/20"
      )}
    >
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {tone && (
          <span
            className={cn("size-2 shrink-0 rounded-full", tones[tone].dot)}
            aria-hidden="true"
          />
        )}
        {title}
      </h3>
      <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
        {text}
      </p>
    </div>
  )
}
/**
 * The documents a result or situation rests on, one line each like a file
 * index (§76): the document's name and its collection, never the passage
 * text. Several passages of one document make one line.
 */
export function SourceIndex({
  sources,
  title = "Fuentes consultadas",
}: {
  sources: EvidenceSource[]
  title?: string
}) {
  const documents = new Map<
    string,
    { title: string; collection?: string; passages: number }
  >()
  for (const source of sources) {
    const key = source.documentId ?? source.id
    const known = documents.get(key)
    if (known) known.passages += 1
    else
      documents.set(key, {
        title: source.title ?? "Documento sin nombre",
        collection: source.collection,
        passages: 1,
      })
  }
  if (!documents.size) return null
  return (
    <section className="space-y-2 text-sm">
      <h3 className="font-medium">{title}</h3>
      <ul className="divide-y rounded-lg border">
        {[...documents].map(([key, document]) => (
          <li key={key} className="flex items-center gap-2 px-3 py-2">
            <FileTextIcon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{document.title}</span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {[
                document.collection,
                document.passages > 1 && `${document.passages} fragmentos`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </li>
        ))}
      </ul>
    </section>
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
            <ReceiptTextFrame
              title="Mensaje al agente"
              text={c.question}
              tone="question"
            />
            <ReceiptTextFrame
              title="Respuesta o comportamiento esperado"
              tone="expected"
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
      sources?: EvidenceSource[]
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
              tone="expected"
              text={
                result.expectedAnswer || "Sin respuesta esperada registrada."
              }
            />
            <ReceiptTextFrame
              title="Respuesta del agente"
              tone="answer"
              text={result.answer || "Sin respuesta registrada."}
            />
            {result.explanation && (
              <ReceiptTextFrame
                title="Resultado de la revisión"
                tone="review"
                text={result.explanation}
              />
            )}
            {result.suggestion && (
              <ReceiptTextFrame title="Observación" text={result.suggestion} />
            )}
            {!!result.sources?.length && (
              <SourceIndex sources={result.sources} />
            )}
          </div>
        </details>
      ))}
    </div>
  )
}
