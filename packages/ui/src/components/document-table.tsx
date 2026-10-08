"use client"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { FileTextIcon, Trash2Icon, RefreshCwIcon } from "lucide-react"
import type { ColumnDef } from "@tanstack/react-table"
import type { WorkspaceView, FormResult } from "@agentonic/contracts/authoring"
import { formatCount } from "@agentonic/contracts/format"
import { DataTable } from "@workspace/ui/components/data-table"
import { MultiSelectFilter } from "@workspace/ui/components/multi-select-filter"
import { sortableHeader } from "@workspace/ui/components/table-cells"
import { processingErrors } from "@agentonic/contracts/rag"
import { DocumentStatusBadge } from "@workspace/ui/components/status-badge"
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
const documentType = (contentType: string) =>
  contentType === "application/pdf"
    ? "PDF"
    : contentType === "text/markdown"
      ? "Markdown"
      : "Texto"
const documentSize = (bytes: number) =>
  new Intl.NumberFormat("es-VE", {
    style: "unit",
    unit: "kilobyte",
    maximumFractionDigits: 1,
  }).format(bytes / 1024)
function documentDetail(document: WorkspaceView["documents"][number]) {
  if (document.status === "ready")
    return `${formatCount(document.chunkCount)} ${document.chunkCount === 1 ? "fragmento" : "fragmentos"}`
  return (
    processingErrors[document.processingError ?? ""] ??
    (document.processingStatus === "not_queued"
      ? "Pendiente de iniciar"
      : document.processingStatus === "failed"
        ? processingErrors.attempts_exhausted
        : "")
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
  type Document = WorkspaceView["documents"][number]
  const header = sortableHeader<Document>
  const [chosenCollections, setShownCollections] = useState<string[]>([])
  // A collection removed while chosen stops filtering.
  const shownCollections = chosenCollections.filter((id) =>
    collections.some((collection) => collection.id === id)
  )
  const rows = shownCollections.length
    ? data.filter((document) =>
        shownCollections.includes(document.collectionId)
      )
    : data
  const columns: ColumnDef<Document>[] = [
    {
      accessorKey: "title",
      header: header("Documento"),
      // Owner direction, 2026-10-08: type and size sit under the name to save
      // width; their own columns stay defined but hidden.
      cell: ({ row }) => (
        <span className="flex items-center gap-2">
          <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span
              className="block max-w-60 truncate"
              title={row.original.title}
            >
              {row.original.title}
            </span>
            <span className="block text-muted-foreground tabular-nums">
              {documentType(row.original.contentType)} ·{" "}
              {documentSize(row.original.size)}
            </span>
          </span>
        </span>
      ),
    },
    {
      id: "type",
      accessorFn: (document) => documentType(document.contentType),
      header: header("Tipo"),
    },
    {
      accessorKey: "size",
      header: header("Tamaño"),
      cell: ({ row }) => (
        <span className="tabular-nums">{documentSize(row.original.size)}</span>
      ),
    },
    {
      id: "collectionName",
      accessorFn: (document) =>
        collections.find((c) => c.id === document.collectionId)?.name ??
        "Colección",
      header: header("Colección"),
      cell: ({ getValue }) => (
        <span className="block max-w-44 truncate" title={getValue<string>()}>
          {getValue<string>()}
        </span>
      ),
    },
    {
      id: "processingState",
      accessorFn: (document) =>
        document.status === "ready" ? "ready" : document.processingStatus,
      header: header("Estado"),
      cell: ({ row }) => <DocumentStatusBadge document={row.original} />,
    },
    {
      id: "detail",
      accessorFn: (document) => documentDetail(document),
      header: header("Detalle"),
      // Free text: an error explanation may wrap.
      cell: ({ row }) =>
        row.original.status === "ready" ? (
          <span className="tabular-nums">{documentDetail(row.original)}</span>
        ) : (
          <span className="block max-w-56 whitespace-normal text-muted-foreground">
            {documentDetail(row.original) || "—"}
          </span>
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
      data={rows}
      columns={columns}
      searchKeys={["title"]}
      variant="integrated"
      searchLabel="Buscar documentos"
      hiddenColumns={["type", "size"]}
      toolbar={
        <MultiSelectFilter
          label="Filtrar por colecciones"
          allLabel="Todas las colecciones"
          countLabel={(count) => `${count} colecciones seleccionadas`}
          options={collections.map((collection) => ({
            value: collection.id,
            label: collection.name,
          }))}
          selected={shownCollections}
          onChange={setShownCollections}
          className="w-full sm:w-56"
        />
      }
      emptyDescription="Todavía no hay documentos. Selecciona una colección y sube tu primer archivo."
    />
  )
}
