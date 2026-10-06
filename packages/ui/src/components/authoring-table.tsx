"use client"
import Link from "next/link"
import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  FileTextIcon,
  EllipsisIcon,
  PencilIcon,
  ChartNoAxesCombinedIcon,
  ScrollTextIcon,
  SquareIcon,
  Trash2Icon,
  ListChecksIcon,
  LibraryBigIcon,
  WrenchIcon,
  PlugIcon,
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
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@workspace/ui/components/tooltip"
import { FiltersCard } from "@workspace/ui/components/filters-card"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@workspace/ui/components/select"
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
  const workspaceOptions = workspaces.map((workspace) => ({
    value: workspace.id,
    label: workspace.name,
  }))
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
  const resources = [
    { key: "skillsCount", label: "Habilidades", icon: ListChecksIcon },
    { key: "collectionsCount", label: "Colecciones", icon: LibraryBigIcon },
    {
      key: "toolsCount",
      label: "Herramientas",
      icon: WrenchIcon,
      upcoming: true,
    },
    {
      key: "connectionsCount",
      label: "Conexiones",
      icon: PlugIcon,
      upcoming: true,
    },
  ] as const
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
      cell: ({ row }) => (
        <div className="max-w-56 min-w-32 whitespace-normal">
          {row.original.canEdit ? (
            <AgentLink
              href={`/agents/${row.original.id}?workspace=${row.original.workspaceId}`}
              name={row.original.name}
            />
          ) : (
            <p className="text-xs font-medium">{row.original.name}</p>
          )}
        </div>
      ),
    },
    {
      accessorKey: "workspaceName",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Espacio de trabajo" />
      ),
    },
    {
      id: "resources",
      header: "Recursos",
      cell: ({ row }) => {
        const configuration = row.original.configuration
        if (!configuration) return unavailable
        const ready =
          configuration.promptCharacters >= SYSTEM_PROMPT_MIN_CHARACTERS
        const instructions = `Instrucciones ${ready ? "listas" : "incompletas"}: ${configuration.promptCharacters} caracteres`
        return (
          <div className="flex items-center gap-4">
            <Tooltip>
              <TooltipTrigger
                render={<span tabIndex={0} />}
                aria-label={instructions}
                className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <FileTextIcon
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden="true"
                />
                <span className="tabular-nums" aria-hidden="true">
                  {configuration.promptCharacters}
                </span>
              </TooltipTrigger>
              <TooltipContent>{instructions}</TooltipContent>
            </Tooltip>
            {resources.map(({ key, label, icon: Icon, ...resource }) => {
              const description = `${label}: ${configuration[key]}${"upcoming" in resource ? " · Próximamente" : ""}`
              return (
                <Tooltip key={key}>
                  <TooltipTrigger
                    render={<span tabIndex={0} />}
                    aria-label={description}
                    className="inline-flex items-center gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Icon
                      className="size-4 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                    <span className="tabular-nums" aria-hidden="true">
                      {configuration[key]}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{description}</TooltipContent>
                </Tooltip>
              )
            })}
          </div>
        )
      },
    },
    ...agentVersionColumns<(typeof agents)[number]>(
      (agent) => agent.configuration?.summary ?? null,
      unavailable
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
          <Select
            multiple
            items={workspaceOptions}
            value={selectedWorkspaceIds}
            disabled={pending}
            onValueChange={selectWorkspaces}
          >
            <SelectTrigger id={filterId} className="w-full">
              <SelectValue>
                {selectedWorkspaceIds.length === 0
                  ? "Todos los espacios"
                  : selectedWorkspaceIds.length === 1
                    ? workspaces.find(
                        (workspace) => workspace.id === selectedWorkspaceIds[0]
                      )?.name
                    : `${selectedWorkspaceIds.length} espacios seleccionados`}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {workspaceOptions.map((workspace) => (
                <SelectItem key={workspace.value} value={workspace.value}>
                  {workspace.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
