import { CheckIcon, MinusIcon, Clock3Icon, CircleAlertIcon } from "lucide-react"

/** Secondary outcomes use quiet text/icons, leaving badges for the record state. */
export function ReviewResultStatus({
  label,
  outcome,
}: {
  label: string
  outcome: "passed" | "failed" | "pending" | "excluded" | "attention"
}) {
  const Icon =
    outcome === "passed"
      ? CheckIcon
      : outcome === "excluded"
        ? MinusIcon
        : outcome === "pending"
          ? Clock3Icon
          : CircleAlertIcon
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 text-xs font-normal ${outcome === "failed" ? "text-destructive" : "text-muted-foreground"}`}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  )
}

export function EvaluationSummary({
  passed,
  total,
  running = false,
}: {
  passed: number
  total: number
  running?: boolean
}) {
  return (
    <div
      className="mb-5 flex items-baseline gap-3 border-b pb-4"
      aria-label={`${passed} de ${total} resultados registrados superados`}
    >
      <span className="text-2xl font-semibold tabular-nums">
        {passed}
        <span className="text-base font-normal text-muted-foreground">
          {" "}
          / {total}
        </span>
      </span>
      <div className="text-sm text-muted-foreground">
        <p>Pruebas superadas</p>
        {running && (
          <p className="text-xs">
            Sobre los resultados recibidos. La evaluación continúa.
          </p>
        )}
      </div>
    </div>
  )
}
