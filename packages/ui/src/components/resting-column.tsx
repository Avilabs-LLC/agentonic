"use client"
import type { Column, ColumnDef } from "@tanstack/react-table"
import { DataTableColumnHeader } from "@workspace/ui/components/data-table"

/** Only a running deployment can rest; elsewhere resting does not apply. */
export const deploymentResting = (d: { status: string; resting: boolean }) =>
  d.status === "running" ? d.resting : null

/** "En reposo" in its own column (UI contract, one fact per cell): Sí, No, or
 * No aplica for null; undefined marks a row whose record is unavailable. */
export function restingColumn<T>(
  resting: (row: T) => boolean | null | undefined,
  unavailable: React.ReactNode = null
): ColumnDef<T> {
  return {
    id: "resting",
    accessorFn: (row) => {
      const value = resting(row)
      return value == null ? -1 : value ? 1 : 0
    },
    header: function SortableHeader({
      column,
    }: {
      column: Column<T, unknown>
    }) {
      return <DataTableColumnHeader column={column} title="En reposo" />
    },
    cell: ({ row }) => {
      const value = resting(row.original)
      if (value === undefined) return unavailable
      if (value === null)
        return <span className="text-muted-foreground">No aplica</span>
      return value ? "Sí" : "No"
    },
  }
}
