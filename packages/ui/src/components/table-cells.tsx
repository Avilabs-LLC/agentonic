"use client"
// Shared table cells (UI contract §3, field standard): every table renders the
// same data point the same way. One fact per cell; a badge stands alone; when a
// cell must hold several facts, each carries its label (FieldStack).
import Link from "next/link"
import type { Column } from "@tanstack/react-table"
import { formatCount, formatUtcParts } from "@agentonic/contracts/format"
import { cn } from "@workspace/ui/lib/utils"
import { DataTableColumnHeader } from "@workspace/ui/components/data-table"
import { StatusIndicator } from "@workspace/ui/components/status-badge"

/** A sortable header with this title, for any column. */
export function sortableHeader<T>(title: string) {
  function SortableHeader({ column }: { column: Column<T, unknown> }) {
    return <DataTableColumnHeader column={column} title={title} />
  }
  return SortableHeader
}

/** Sort key for a timestamp; a missing one sorts first. */
export const timeKey = (value: string | null | undefined) =>
  value == null ? -Infinity : Date.parse(value)

/** Muted text for an absent or not-applicable value. */
export function Absent({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>
}

/** A timestamp: the date over its muted UTC time. */
export function When({
  value,
  empty = "Sin registro",
}: {
  value: string | null | undefined
  empty?: string
}) {
  if (value == null) return <Absent>{empty}</Absent>
  const { date, time } = formatUtcParts(value)
  return (
    <div className="tabular-nums">
      <p>{date}</p>
      <p className="text-muted-foreground">{time}</p>
    </div>
  )
}

/** A deadline: like When, but a lapsed one is a warning (§9.1). */
export function Deadline({
  value,
  now,
  empty = "No aplica",
}: {
  value: string | null | undefined
  now: string
  empty?: string
}) {
  if (value == null) return <Absent>{empty}</Absent>
  const { date, time } = formatUtcParts(value)
  return (
    <div className="tabular-nums">
      {Date.parse(value) <= Date.parse(now) ? (
        <StatusIndicator
          state={{
            label: `Venció el ${date}`,
            variant: "warning",
            icon: "clock",
          }}
        />
      ) : (
        <p>{date}</p>
      )}
      <p className="text-muted-foreground">{time}</p>
    </div>
  )
}

/** A count: plain tabular numerals. */
export function Count({ value }: { value: number }) {
  return <span className="tabular-nums">{formatCount(value)}</span>
}

/** Monospaced identifiers: commits, artifacts, workers, record ids. */
export function Code({ children }: { children: React.ReactNode }) {
  return <span className="font-mono">{children}</span>
}

export type StackField = { label: string; value: React.ReactNode }
/** Several facts in one cell, each under its label (as in corbero-cloud). */
export function FieldStack({ fields }: { fields: StackField[] }) {
  return (
    <dl className="flex flex-col gap-1">
      {fields.map((field) => (
        <div key={field.label} className="flex flex-col gap-0.5">
          <dt className="text-muted-foreground">{field.label}:</dt>
          <dd>{field.value}</dd>
        </div>
      ))}
    </dl>
  )
}

// Clickable text in tables: one style for links and link buttons.
export const cellLinkClass =
  "cursor-pointer font-medium text-link underline underline-offset-4 outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"

export function CellLink({
  href,
  children,
  className,
}: {
  href: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <Link href={href} className={cn(cellLinkClass, className)}>
      {children}
    </Link>
  )
}

export function CellButton({
  className,
  ...props
}: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className={cn(cellLinkClass, "text-left", className)}
      {...props}
    />
  )
}
