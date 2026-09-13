import Link from "next/link"
import { ArrowLeftIcon } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
export function BackRow({ href }: { href: string }) {
  return (
    <Button
      render={<Link href={href} />}
      nativeButton={false}
      variant="ghost"
      className="-ml-2"
    >
      <ArrowLeftIcon />
      Volver atrás
    </Button>
  )
}
export function RecordHeader({
  title,
  description,
  actions,
}: {
  title: string
  description: string
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
