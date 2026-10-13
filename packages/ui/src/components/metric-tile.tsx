import type { ReactNode } from "react"
import { cn } from "@workspace/ui/lib/utils"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@workspace/ui/components/card"

// A metric tile (the Admin agent page, Despliegues): label, prominent value,
// detail. Every tile keeps all three rows (a placeholder when a detail is
// missing) so their text lines up; the value takes its state's colour instead
// of a badge (UI contract §9).
export function MetricTile({
  label,
  value,
  tone,
  detail,
}: {
  label: string
  value: ReactNode
  tone?: string
  detail: ReactNode
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="text-xs font-medium tracking-wide uppercase">
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
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
      </CardContent>
    </Card>
  )
}
