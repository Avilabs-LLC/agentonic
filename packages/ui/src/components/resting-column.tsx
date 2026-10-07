"use client"
import type { Column, ColumnDef } from "@tanstack/react-table"
import { DataTableColumnHeader } from "@workspace/ui/components/data-table"

/** "En reposo" in its own column: only a running deployment can rest. */
export function restingColumn<
  T extends { status: string; resting: boolean },
>(): ColumnDef<T> {
  const running = (row: T) => row.status === "running"
  return {
    id: "resting",
    accessorFn: (row) => (running(row) ? (row.resting ? 1 : 0) : -1),
    header: function SortableHeader({
      column,
    }: {
      column: Column<T, unknown>
    }) {
      return <DataTableColumnHeader column={column} title="En reposo" />
    },
    cell: ({ row }) =>
      running(row.original) ? (
        row.original.resting ? (
          "Sí"
        ) : (
          "No"
        )
      ) : (
        <span className="text-muted-foreground">No aplica</span>
      ),
  }
}
