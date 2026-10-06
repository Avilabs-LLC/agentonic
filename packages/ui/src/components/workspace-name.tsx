import { Building2Icon } from "lucide-react"
import { cn } from "@workspace/ui/lib/utils"

/** A workspace's name with the sidebar's workspace icon. */
export function WorkspaceName({
  name,
  className,
}: {
  name: string
  className?: string
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <Building2Icon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{name}</span>
    </span>
  )
}
