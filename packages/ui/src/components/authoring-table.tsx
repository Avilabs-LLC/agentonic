"use client"
import { WorkspaceName } from "@workspace/ui/components/workspace-name"
import Link from "next/link"
import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  EllipsisIcon,
  PencilIcon,
  ChartNoAxesCombinedIcon,
  ScrollTextIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuLabel,
} from "@workspace/ui/components/dropdown-menu"
import type { ColumnDef } from "@tanstack/react-table"
import {
  SYSTEM_PROMPT_MIN_CHARACTERS,
  type AgentListing,
} from "@agentonic/contracts/authoring"
import {
  DataTable,
  DataTableColumnHeader,
} from "@workspace/ui/components/data-table"
import { Button } from "@workspace/ui/components/button"
import { FiltersCard } from "@workspace/ui/components/filters-card"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { MultiSelectFilter } from "@workspace/ui/components/multi-select-filter"
import { ResourceCounts } from "@workspace/ui/components/resource-counts"
import {
  AgentLink,
  agentVersionColumns,
} from "@workspace/ui/components/agent-versions"
export function AuthoringTable({
  agents,
  workspaces,
  selectedWorkspaceIds,
}: {
  agents: (AgentListing[number] & {
    workspaceId: string
    workspaceName: string
  })[]
  workspaces: { id: string; name: string }[]
  selectedWorkspaceIds: string[]
}) {
  const router = useRouter()
  const filterId = useId()
  const [pending, startTransition] = useTransition()
  const [tableReset, setTableReset] = useState(0)
  function selectWorkspaces(ids: string[]) {
    const query = new URLSearchParams()
    ids.forEach((id) => query.append("workspace", id))
    startTransition(() =>
      router.push(query.size ? `/agents?${query}` : "/agents", {
        scroll: false,
      })
    )
  }
  const unavailable = (
    <span
      className="text-muted-foreground"
      title="Solo tienes acceso a los metadatos del agente."
    >
      Sin acceso
    </span>
  )
  const columns: ColumnDef<(typeof agents)[number]>[] = [
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Acciones de ${row.original.name}`}
              />
            }
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {row.original.canEdit ? (
              <DropdownMenuItem
                render={
                  <Link
                    href={`/agents/${row.original.id}?workspace=${row.original.workspaceId}`}
                  />
                }
              >
                <PencilIcon />
                Editar agente
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem disabled>
                <PencilIcon />
                Editar · Sin permiso
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Próximamente</DropdownMenuLabel>
              <DropdownMenuItem disabled>
                <ChartNoAxesCombinedIcon />
                Ver costos y consumo
              </DropdownMenuItem>
              <DropdownMenuItem disabled>
                <ScrollTextIcon />
                Ver registros
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled variant="destructive">
                <SquareIcon />
                Detener agente
              </DropdownMenuItem>
              <DropdownMenuItem disabled variant="destructive">
                <Trash2Icon />
                Eliminar agente
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
    {
      accessorKey: "name",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Agente" />
      ),
      cell: ({ row }) =>
        row.original.canEdit ? (
          <AgentLink
            href={`/agents/${row.original.id}?workspace=${row.original.workspaceId}`}
            name={row.original.name}
          />
        ) : (
          row.original.name
        ),
    },
    {
      accessorKey: "workspaceName",
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title="Espacio"
          description="Espacio de trabajo"
        />
      ),
      cell: ({ row }) => <WorkspaceName name={row.original.workspaceName} />,
    },
    {
      id: "resources",
      header: "Recursos",
      cell: ({ row }) =>
        row.original.configuration ? (
          <ResourceCounts value={row.original.configuration} />
        ) : (
          unavailable
        ),
    },
    ...agentVersionColumns<(typeof agents)[number]>(
      (agent) => agent.configuration?.summary ?? null,
      unavailable,
      "customer"
    ),
  ]
  return (
    <div className="space-y-4" aria-busy={pending}>
      <FiltersCard
        description="Filtra los agentes por uno o varios espacios de trabajo."
        disabled={pending}
        onClear={() => {
          setTableReset((value) => value + 1)
          selectWorkspaces([])
        }}
      >
        <Field>
          <FieldLabel htmlFor={filterId}>Espacios de trabajo</FieldLabel>
          <MultiSelectFilter
            id={filterId}
            allLabel="Todos los espacios"
            countLabel={(count) => `${count} espacios seleccionados`}
            options={workspaces.map((workspace) => ({
              value: workspace.id,
              label: workspace.name,
            }))}
            selected={selectedWorkspaceIds}
            disabled={pending}
            onChange={selectWorkspaces}
          />
        </Field>
      </FiltersCard>
      <p className="text-sm text-muted-foreground">
        Los conteos corresponden al borrador guardado. Instrucciones listas: al
        menos {SYSTEM_PROMPT_MIN_CHARACTERS} caracteres sin contar espacios.
        Desliza horizontalmente para ver todas las columnas.
      </p>
      <DataTable
        key={`${selectedWorkspaceIds.join(",")}-${tableReset}`}
        columns={columns}
        data={agents}
        searchKeys={["name", "description", "slug", "id", "workspaceName"]}
        searchLabel="Buscar agentes"
        getRowId={(agent) => agent.id}
      />
    </div>
  )
}
