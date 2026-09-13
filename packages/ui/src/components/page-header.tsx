import { formatCount } from "@agentonic/contracts/format"
export function PageHeader({
  title,
  description,
  count,
  actions,
}: {
  title: string
  description: string
  count?: number
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold tracking-tight">
          {title}
          {count !== undefined ? `: ${formatCount(count)}` : ""}
        </h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {actions}
    </div>
  )
}
