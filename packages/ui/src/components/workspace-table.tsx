"use client"
import type { ColumnDef } from "@tanstack/react-table"
import {
  DataTable,
  DataTableColumnHeader,
} from "@workspace/ui/components/data-table"
type WorkspaceRow = {
  id: string
  name: string
  kind: string
  role: string
  timezone: string
}
const roles: Record<string, string> = {
  owner: "Propietario",
  admin: "Administrador",
  member: "Miembro",
  viewer: "Lector",
}
const columns: ColumnDef<WorkspaceRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Espacio" />
    ),
  },
  {
    accessorKey: "kind",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Tipo" />
    ),
    cell: ({ row }) =>
      row.original.kind === "personal" ? "Personal" : "Organización",
  },
  {
    accessorKey: "role",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Tu rol" />
    ),
    cell: ({ row }) => roles[row.original.role] ?? row.original.role,
  },
  {
    accessorKey: "timezone",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Zona horaria" />
    ),
  },
]
export function WorkspaceTable({ workspaces }: { workspaces: WorkspaceRow[] }) {
  return (
    <DataTable
      data={workspaces}
      columns={columns}
      searchKeys={["name", "timezone"]}
    />
  )
}
