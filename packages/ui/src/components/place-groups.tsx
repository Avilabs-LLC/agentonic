import type { ReactNode } from "react"
import { BotIcon, FlaskConicalIcon } from "lucide-react"
import { environmentLabels } from "@agentonic/contracts/lifecycle"
import { cn } from "@workspace/ui/lib/utils"

// Servers and evaluators as a grid (Vencimientos, Despliegues): one row per
// kind, headed once by its icon and name, and one column per place, the VM
// first. Each cell stacks its facts one per line, with its badge alone on the
// right. Every cell stays visible, since a lapsed one stops work there. Below
// md each row stacks its places, and each cell names its place.
const places = ["azure_staging", "local"] as const
export const placeKinds = {
  agents: { label: "Agentes", icon: BotIcon },
  evaluations: { label: "Evaluaciones", icon: FlaskConicalIcon },
} as const
export type PlaceItem = {
  environment: (typeof places)[number]
  kind: keyof typeof placeKinds
  lines: ReactNode[]
  action: ReactNode
}
// The kind column is fixed so every row lines up with the header row.
const grid = {
  1: "md:grid-cols-[10rem_minmax(0,1fr)]",
  2: "md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,1fr)]",
}
export function PlaceGroups({ items }: { items: PlaceItem[] }) {
  const columns = places.filter((p) => items.some((i) => i.environment === p))
  const kinds = (Object.keys(placeKinds) as PlaceItem["kind"][]).filter(
    (kind) => items.some((i) => i.kind === kind)
  )
  const template = grid[columns.length as 1 | 2]
  return (
    <div>
      <div
        aria-hidden="true"
        className={cn("hidden gap-x-6 border-b pb-2 md:grid", template)}
      >
        <span />
        {columns.map((environment) => (
          <span
            key={environment}
            className="text-xs font-medium text-muted-foreground"
          >
            {environmentLabels[environment]}
          </span>
        ))}
      </div>
      <div className="divide-y">
        {kinds.map((kind) => {
          const { label, icon: Icon } = placeKinds[kind]
          return (
            <section
              key={kind}
              aria-labelledby={`place-kind-${kind}`}
              className={cn(
                "grid gap-x-6 gap-y-3 py-4 first:pt-0 last:pb-0 md:first:pt-4",
                template
              )}
            >
              <h3
                id={`place-kind-${kind}`}
                className="flex items-center gap-2 self-start text-sm font-medium"
              >
                <Icon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                {label}
              </h3>
              {columns.map((environment) => {
                const item = items.find(
                  (i) => i.kind === kind && i.environment === environment
                )
                return (
                  <div
                    key={environment}
                    className="flex min-w-0 items-start justify-between gap-3"
                  >
                    <div className="min-w-0 space-y-0.5 text-sm text-muted-foreground">
                      <p className="text-xs font-medium md:sr-only">
                        {environmentLabels[environment]}
                      </p>
                      {item ? (
                        item.lines.map((line, index) => (
                          <p key={index} className="break-words">
                            {line}
                          </p>
                        ))
                      ) : (
                        <p>Sin registrar</p>
                      )}
                    </div>
                    {item && <div className="shrink-0">{item.action}</div>}
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}
