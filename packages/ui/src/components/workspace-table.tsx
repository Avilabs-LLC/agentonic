"use client"
import type { ColumnDef } from "@tanstack/react-table"
import { memberRoleLabels } from "@agentonic/contracts/access"
import { workspaceKindLabels } from "@agentonic/contracts/operations"
import { DataTable } from "@workspace/ui/components/data-table"
import { sortableHeader } from "@workspace/ui/components/table-cells"
import { WorkspaceName } from "@workspace/ui/components/workspace-name"
type WorkspaceRow = {
  id: string
  name: string
  kind: string
  role: string
  timezone: string
}
const columns: ColumnDef<WorkspaceRow>[] = [
  {
    accessorKey: "name",
    header: sortableHeader<WorkspaceRow>("Espacio", "Espacio de trabajo"),
    cell: ({ row }) => <WorkspaceName name={row.original.name} />,
  },
  {
    id: "kind",
    accessorFn: (row) => workspaceKindLabels[row.kind] ?? row.kind,
    header: sortableHeader<WorkspaceRow>("Tipo"),
  },
  {
    id: "role",
    accessorFn: (row) => memberRoleLabels[row.role] ?? row.role,
    header: sortableHeader<WorkspaceRow>("Tu rol"),
  },
  {
    accessorKey: "timezone",
    header: sortableHeader<WorkspaceRow>("Zona", "Zona horaria"),
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
