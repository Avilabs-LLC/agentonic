"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { FileTextIcon, Trash2Icon, RefreshCwIcon } from "lucide-react"
import type { ColumnDef } from "@tanstack/react-table"
import type { WorkspaceView, FormResult } from "@agentonic/contracts/authoring"
import {
  DataTable,
  DataTableColumnHeader,
} from "@workspace/ui/components/data-table"
import { processingErrors } from "@agentonic/contracts/rag"
import { Badge } from "@workspace/ui/components/badge"
import { DocumentDownload } from "@workspace/ui/components/document-download"
import { Button } from "@workspace/ui/components/button"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@workspace/ui/components/tooltip"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
  AlertDialogAction,
} from "@workspace/ui/components/alert-dialog"
import { notify } from "@workspace/ui/lib/toast"

function DocumentActions({
  document,
  workspaceId,
  remove,
  process,
}: {
  document: WorkspaceView["documents"][number]
  workspaceId: string
  process: (id: string) => Promise<FormResult>
  remove: (id: string) => Promise<FormResult>
}) {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const router = useRouter()
  async function enqueue() {
    setPending(true)
    try {
      const result = await process(document.id)
      if (result.ok) {
        notify.success(result.message)
        router.refresh()
      } else notify.destructive(result.message)
    } catch {
      notify.destructive("No se pudo iniciar el procesamiento.")
    } finally {
      setPending(false)
    }
  }
  async function confirm() {
    if (pending) return
    setPending(true)
    try {
      const result = await remove(document.id)
      if (!result.ok) {
        notify.destructive(result.message)
        return
      }
      notify.success(result.message)
      setOpen(false)
      router.refresh()
    } catch {
      notify.destructive("No se pudo retirar el documento. Inténtalo de nuevo.")
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <div className="flex items-center justify-end gap-1">
        {document.uploadStatus === "uploaded" && (
          <DocumentDownload
            objectId={document.id}
            workspaceId={workspaceId}
            title={document.title}
          />
        )}
        {document.canRemove &&
          document.uploadStatus === "uploaded" &&
          !["queued", "running"].includes(document.processingStatus) &&
          document.status !== "ready" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    disabled={pending}
                    aria-label={`Procesar ${document.title}`}
                    onClick={() => void enqueue()}
                  />
                }
              >
                <RefreshCwIcon />
              </TooltipTrigger>
              <TooltipContent>Procesar documento</TooltipContent>
            </Tooltip>
          )}
        {document.canRemove && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={pending}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Retirar ${document.title}`}
                  onClick={() => setOpen(true)}
                />
              }
            >
              <Trash2Icon />
            </TooltipTrigger>
            <TooltipContent>Retirar documento</TooltipContent>
          </Tooltip>
        )}
      </div>
      <AlertDialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>¿Eliminar este documento?</AlertDialogTitle>
            <AlertDialogDescription className="break-words">
              {document.title} se eliminará del conocimiento de los agentes. Se
              borrarán sus fragmentos, embeddings y archivo original. No se
              puede deshacer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              onClick={(event) => {
                event.preventDefault()
                void confirm()
              }}
            >
              {pending ? "Eliminando…" : "Eliminar documento"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
export function DocumentTable({
  data,
  collections,
  workspaceId,
  remove,
  process,
}: {
  data: WorkspaceView["documents"]
  collections: WorkspaceView["collections"]
  workspaceId: string
  process: (id: string) => Promise<FormResult>
  remove: (id: string) => Promise<FormResult>
}) {
  const columns: ColumnDef<WorkspaceView["documents"][number]>[] = [
    {
      accessorKey: "title",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Documento" />
      ),
      cell: ({ row }) => (
        <div className="flex items-center gap-3">
          <FileTextIcon className="size-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p
              className="max-w-60 truncate font-medium"
              title={row.original.title}
            >
              {row.original.title}
            </p>
            <p className="text-xs text-muted-foreground">
              {row.original.contentType === "application/pdf"
                ? "PDF"
                : row.original.contentType === "text/markdown"
                  ? "Markdown"
                  : "Texto"}{" "}
              ·{" "}
              {new Intl.NumberFormat("es-VE", {
                style: "unit",
                unit: "kilobyte",
                maximumFractionDigits: 1,
              }).format(row.original.size / 1024)}
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "collectionName",
      accessorFn: (document) =>
        collections.find((c) => c.id === document.collectionId)?.name ??
        "Colección",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Colección" />
      ),
      cell: ({ getValue }) => (
        <p
          className="max-w-44 truncate text-muted-foreground"
          title={getValue<string>()}
        >
          {getValue<string>()}
        </p>
      ),
    },
    {
      id: "processingState",
      accessorFn: (document) =>
        document.status === "ready" ? "ready" : document.processingStatus,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Estado" />
      ),
      cell: ({ row }) => (
        <div className="space-y-1">
          <Badge variant="outline" className="rounded-full">
            {row.original.status === "ready"
              ? "Listo"
              : row.original.processingStatus === "running"
                ? "Procesando"
                : row.original.processingStatus === "queued"
                  ? "En cola"
                  : row.original.status === "failed" ||
                      row.original.processingStatus === "failed"
                    ? "Error"
                    : "Sin procesar"}
          </Badge>
          <p className="max-w-48 text-xs whitespace-normal text-muted-foreground">
            {row.original.status === "ready"
              ? `${row.original.chunkCount} fragmentos`
              : (processingErrors[row.original.processingError ?? ""] ??
                (row.original.processingStatus === "not_queued"
                  ? "Pendiente de iniciar"
                  : row.original.processingStatus === "failed"
                    ? processingErrors.attempts_exhausted
                    : ""))}
          </p>
        </div>
      ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <DocumentActions
          document={row.original}
          workspaceId={workspaceId}
          remove={remove}
          process={process}
        />
      ),
    },
  ]
  return (
    <DataTable
      data={data}
      columns={columns}
      searchKeys={["title"]}
      variant="integrated"
      searchLabel="Buscar documentos"
      emptyDescription="Todavía no hay documentos. Selecciona una colección y sube tu primer archivo."
    />
  )
}
