"use client"
import type { ColumnDef } from "@tanstack/react-table"
import type { WorkspaceView, FormResult } from "@agentonic/contracts/authoring"
import {
  DataTable,
  DataTableColumnHeader,
} from "@workspace/ui/components/data-table"
import { Badge } from "@workspace/ui/components/badge"
import { ConfirmMutation } from "@workspace/ui/components/confirm-mutation"
import { DocumentDownload } from "@workspace/ui/components/document-download"
export function DocumentTable({
  data,
  collections,
  workspaceId,
  remove,
}: {
  data: WorkspaceView["documents"]
  collections: WorkspaceView["collections"]
  workspaceId: string
  remove: (id: string) => Promise<FormResult>
}) {
  const columns: ColumnDef<WorkspaceView["documents"][number]>[] = [
    {
      accessorKey: "title",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Documento" />
      ),
    },
    {
      accessorKey: "collectionId",
      header: "Colección",
      cell: ({ row }) =>
        collections.find((c) => c.id === row.original.collectionId)?.name ??
        "Colección",
    },
    {
      accessorKey: "size",
      header: "Tamaño",
      cell: ({ row }) =>
        new Intl.NumberFormat("es-VE", {
          style: "unit",
          unit: "kilobyte",
          maximumFractionDigits: 1,
        }).format(row.original.size / 1024),
    },
    {
      accessorKey: "uploadStatus",
      header: "Estado",
      cell: ({ row }) => (
        <Badge variant="outline" className="rounded-full">
          {row.original.uploadStatus === "uploaded"
            ? "Pendiente de procesamiento"
            : "Carga incompleta"}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-2">
          {row.original.uploadStatus === "uploaded" && (
            <DocumentDownload
              objectId={row.original.id}
              workspaceId={workspaceId}
              title={row.original.title}
            />
          )}
          {row.original.canRemove && (
            <ConfirmMutation
              label="Retirar"
              description="El documento dejará de estar disponible. Los archivos retenidos por políticas de conservación se eliminan por separado."
              action={() => remove(row.original.id)}
            />
          )}
        </div>
      ),
    },
  ]
  return <DataTable data={data} columns={columns} searchKeys={["title"]} />
}
