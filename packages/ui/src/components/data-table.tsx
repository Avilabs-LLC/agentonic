"use client"
import { useState } from "react"
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type Column,
} from "@tanstack/react-table"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronsUpDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
} from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@workspace/ui/components/select"
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from "@workspace/ui/components/table"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
export function DataTableColumnHeader<T>({
  column,
  title,
  description,
}: {
  column: Column<T>
  title: string
  // The full name behind a shortened header, shown on hover and read aloud.
  description?: string
}) {
  const direction = column.getIsSorted()
  const Icon =
    direction === "asc"
      ? ArrowUpIcon
      : direction === "desc"
        ? ArrowDownIcon
        : ChevronsUpDownIcon
  return (
    <Button
      variant="ghost"
      onClick={() => column.toggleSorting(direction === "asc")}
      className="-ml-2"
      title={description}
      aria-label={`Ordenar por ${description ?? title}`}
    >
      <span>{title}</span>
      <Icon />
    </Button>
  )
}
export function DataTable<T>({
  data,
  columns,
  searchKeys,
  variant = "default",
  searchLabel = "Buscar registros",
  emptyDescription = "Prueba con otros términos de búsqueda.",
  getRowId,
}: {
  data: T[]
  columns: ColumnDef<T>[]
  searchKeys: (keyof T)[]
  variant?: "default" | "integrated"
  searchLabel?: string
  emptyDescription?: string
  getRowId?: (row: T) => string
}) {
  const [sorting, setSorting] = useState<SortingState>([])
  const [search, setSearch] = useState("")
  // TanStack v8 deliberately remains outside React Compiler memoization.
  // eslint-disable-next-line react-hooks/incompatible-library
  const table = useReactTable({
    data,
    columns,
    getRowId,
    state: { sorting, globalFilter: search },
    onSortingChange: setSorting,
    onGlobalFilterChange: setSearch,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    globalFilterFn: (row, _column, value: string) =>
      value
        .toLocaleLowerCase("es")
        .trim()
        .split(/\s+/)
        .every((term) =>
          searchKeys.some((key) =>
            String(row.original[key] ?? "")
              .toLocaleLowerCase("es")
              .includes(term)
          )
        ),
    initialState: { pagination: { pageSize: 10 } },
  })
  return (
    <div className="space-y-4">
      <Input
        aria-label={searchLabel}
        placeholder={
          searchLabel === "Buscar registros" ? "Buscar…" : `${searchLabel}…`
        }
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="max-w-sm"
      />
      <div
        className={
          variant === "integrated"
            ? "border-t"
            : "overflow-hidden rounded-xl border"
        }
      >
        <div>
          <Table
            containerClassName="max-h-[32rem]"
            className={
              variant === "integrated"
                ? "text-xs [&_td]:py-4 [&_td:first-child]:pl-0 [&_td:last-child]:pr-0 [&_th:first-child]:pl-0 [&_th:last-child]:pr-0"
                : undefined
            }
          >
            <TableHeader
              className={
                variant === "integrated"
                  ? "sticky top-0 z-10 bg-card"
                  : "sticky top-0 z-10 bg-muted"
              }
            >
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead
                      key={header.id}
                      aria-sort={
                        header.column.getIsSorted() === "asc"
                          ? "ascending"
                          : header.column.getIsSorted() === "desc"
                            ? "descending"
                            : "none"
                      }
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {flexRender(
                          cell.column.columnDef.cell,
                          cell.getContext()
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell colSpan={columns.length}>
                    <Empty>
                      <EmptyHeader>
                        <EmptyTitle>Sin resultados</EmptyTitle>
                        <EmptyDescription>
                          {search
                            ? "Prueba con otros términos de búsqueda."
                            : emptyDescription}
                        </EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <span>{table.getFilteredRowModel().rows.length} registros</span>
        <div className="flex flex-wrap items-center gap-3">
          <span>Filas</span>
          <Select
            value={String(table.getState().pagination.pageSize)}
            onValueChange={(value) => {
              const size = Number(value)
              if (size && size !== table.getState().pagination.pageSize)
                table.setPageSize(size)
            }}
          >
            <SelectTrigger aria-label="Filas por página">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 50].map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span>
            Página {table.getState().pagination.pageIndex + 1} de{" "}
            {Math.max(1, table.getPageCount())}
          </span>
          <Button
            variant="outline"
            size="icon"
            disabled={!table.getCanPreviousPage()}
            onClick={() => table.previousPage()}
            aria-label="Página anterior"
          >
            <ChevronLeftIcon />
          </Button>
          <Button
            variant="outline"
            size="icon"
            disabled={!table.getCanNextPage()}
            onClick={() => table.nextPage()}
            aria-label="Página siguiente"
          >
            <ChevronRightIcon />
          </Button>
        </div>
      </div>
    </div>
  )
}
