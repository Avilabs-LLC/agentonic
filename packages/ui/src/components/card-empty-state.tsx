import type { ReactNode } from "react"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"

export function CardEmptyState({
  title,
  children,
}: {
  title: string
  children?: ReactNode
}) {
  return (
    <Empty className="min-h-32 border bg-muted/20">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {children && <EmptyDescription>{children}</EmptyDescription>}
      </EmptyHeader>
    </Empty>
  )
}
