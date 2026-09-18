"use client"

import { useState } from "react"
import { FolderIcon, PlusIcon } from "lucide-react"
import type { ColumnDef } from "@tanstack/react-table"
import type { FormResult, WorkspaceView } from "@agentonic/contracts/authoring"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import {
  DataTable,
  DataTableColumnHeader,
} from "@workspace/ui/components/data-table"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import { ResourceCreateForm } from "@workspace/ui/components/resource-create-form"
import { CollectionDeleteDialog } from "@workspace/ui/components/collection-delete-dialog"

type CollectionRow = WorkspaceView["collections"][number] & {
  documentCount: number
  remove: (id: string, confirmationName: string) => Promise<FormResult>
}

const columns: ColumnDef<CollectionRow>[] = [
  {
    accessorKey: "name",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Colección" />
    ),
    cell: ({ row }) => (
      <div className="flex items-center gap-3">
        <FolderIcon className="size-5 shrink-0 text-muted-foreground" />
        <span
          className="max-w-64 truncate font-medium"
          title={row.original.name}
        >
          {row.original.name}
        </span>
      </div>
    ),
  },
  {
    accessorKey: "documentCount",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Documentos" />
    ),
    cell: ({ row }) => (
      <span className="text-muted-foreground tabular-nums">
        {row.original.documentCount}
      </span>
    ),
  },
  {
    accessorKey: "canCurate",
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title="Tu acceso" />
    ),
    cell: ({ row }) => (
      <span className="text-sm text-muted-foreground">
        {row.original.canCurate ? "Gestionar" : "Solo lectura"}
      </span>
    ),
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) =>
      row.original.canCurate ? (
        <div className="flex justify-end">
          <CollectionDeleteDialog
            collection={row.original}
            remove={row.original.remove}
          />
        </div>
      ) : null,
  },
]

export function KnowledgeCollections({
  collections,
  documents,
  create,
  remove,
  canCreate,
}: {
  collections: WorkspaceView["collections"]
  documents: WorkspaceView["documents"]
  create: (data: FormData) => Promise<FormResult>
  remove: (id: string, confirmationName: string) => Promise<FormResult>
  canCreate: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const counts = new Map<string, number>()
  for (const document of documents)
    counts.set(
      document.collectionId,
      (counts.get(document.collectionId) ?? 0) + 1
    )
  return (
    <AgentSettingsCard
      title="Colecciones"
      description="Agrupa tus documentos por tema para elegir qué conocimiento compartes con cada agente."
      footer={
        <>
          <p className="min-w-0 flex-1">
            Cada colección conserva sus propios permisos.
          </p>
          <Dialog
            open={open}
            onOpenChange={(value) => {
              if (!pending) setOpen(value)
            }}
          >
            <DialogTrigger
              render={<Button disabled={!canCreate} className="shrink-0" />}
            >
              <PlusIcon aria-hidden="true" />
              Crear colección
            </DialogTrigger>
            <DialogContent showCloseButton={!pending}>
              <DialogTitle>Crear colección</DialogTitle>
              <DialogDescription>
                Organiza documentos relacionados en una colección privada.
              </DialogDescription>
              <ResourceCreateForm
                action={create}
                disabled={!canCreate}
                onPendingChange={setPending}
                onCancel={() => setOpen(false)}
                onSuccess={() => setOpen(false)}
              />
            </DialogContent>
          </Dialog>
        </>
      }
    >
      <DataTable
        data={collections.map((collection) => ({
          ...collection,
          documentCount: counts.get(collection.id) ?? 0,
          remove,
        }))}
        columns={columns}
        getRowId={(collection) => collection.id}
        searchKeys={["name"]}
        variant="integrated"
        searchLabel="Buscar colecciones"
        emptyDescription={
          canCreate
            ? "Crea tu primera colección para empezar a organizar documentos."
            : "Todavía no tienes acceso a ninguna colección en este espacio."
        }
      />
    </AgentSettingsCard>
  )
}
