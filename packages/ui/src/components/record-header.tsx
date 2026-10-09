export { BackRow } from "@workspace/ui/components/back-row"
export function RecordHeader({
  title,
  description,
  actions,
}: {
  title: string
  description: React.ReactNode
  actions?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-2">
        <h1 className="text-3xl font-bold">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      {actions}
    </div>
  )
}
