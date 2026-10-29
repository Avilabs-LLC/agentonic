import { useId, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@workspace/ui/lib/utils"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"

export type Metric = {
  label: string
  value: ReactNode
  tone?: string
  detail: ReactNode
}
const labelClass = "text-xs font-medium tracking-wide uppercase"
// The value and its detail, alike in a tile and in a group.
function MetricRows({ value, tone, detail }: Omit<Metric, "label">) {
  return (
    <>
      <p
        className={cn(
          "truncate text-lg leading-snug font-semibold",
          tone ?? "text-foreground"
        )}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </p>
      <p
        className="truncate text-xs text-muted-foreground"
        title={typeof detail === "string" ? detail : undefined}
      >
        {detail ?? "—"}
      </p>
    </>
  )
}
// A metric tile (the Admin agent page): label, prominent value, detail. Every
// tile keeps all three rows (a placeholder when a detail is missing) so their
// text lines up; the value takes its state's colour instead of a badge (UI
// contract §9).
export function MetricTile({ label, ...rows }: Metric) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className={labelClass}>{label}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        <MetricRows {...rows} />
      </CardContent>
    </Card>
  )
}
// Related metrics in one card (Despliegues, Vencimientos): headed by an icon
// and a name, the metrics side by side with a divider, each with the tile's
// three rows. Below sm they stack.
export function MetricGroup({
  icon: Icon,
  title,
  metrics,
}: {
  icon: LucideIcon
  title: string
  metrics: Metric[]
}) {
  const id = useId()
  return (
    <Card role="group" aria-labelledby={id}>
      <CardHeader>
        <CardTitle id={id} className="flex items-center gap-2 text-sm">
          <Icon
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid divide-y sm:auto-cols-fr sm:grid-flow-col sm:divide-x sm:divide-y-0">
        {metrics.map(({ label, ...rows }) => (
          <div
            key={label}
            className="min-w-0 space-y-1 py-3 first:pt-0 last:pb-0 sm:px-4 sm:py-0 sm:first:pl-0 sm:last:pr-0"
          >
            <p className={cn(labelClass, "text-muted-foreground")}>{label}</p>
            <MetricRows {...rows} />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
