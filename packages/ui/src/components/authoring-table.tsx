"use client"
import Link from "next/link"
import {
  CheckIcon,
  XIcon,
  RocketIcon,
  Clock3Icon,
  EllipsisIcon,
  PencilIcon,
  ChartNoAxesCombinedIcon,
  ScrollTextIcon,
  SquareIcon,
  Trash2Icon,
} from "lucide-react"
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@workspace/ui/components/tooltip"
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
import { Badge } from "@workspace/ui/components/badge"
export function AuthoringTable({
  agents,
  workspaceId,
}: {
  agents: AgentListing
  workspaceId: string
}) {
  const unavailable = (
    <span
      className="text-muted-foreground"
      title="Solo tienes acceso a los metadatos del agente."
    >
      Sin acceso
    </span>
  )
  const counts = (
    key: "skillsCount" | "collectionsCount" | "toolsCount" | "connectionsCount",
    title: string,
    upcoming = false
  ): ColumnDef<AgentListing[number]> => ({
    id: key,
    accessorFn: (agent) => agent.configuration?.[key] ?? -1,
    header: ({ column }) => (
      <DataTableColumnHeader column={column} title={title} />
    ),
    cell: ({ row }) =>
      row.original.configuration ? (
        <div className="space-y-1">
          <p className="tabular-nums">{row.original.configuration[key]}</p>
          {upcoming && (
            <p className="text-xs text-muted-foreground">Próximamente</p>
          )}
        </div>
      ) : (
        unavailable
      ),
  })
  const columns: ColumnDef<AgentListing[number]>[] = [
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
                    href={`/agents/${row.original.id}?workspace=${workspaceId}`}
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
        <div className="max-w-56 min-w-48 whitespace-normal">
          {row.original.canEdit ? (
            <Link
              href={`/agents/${row.original.id}?workspace=${workspaceId}`}
              className="font-medium text-blue-600 underline underline-offset-4 outline-none hover:text-blue-800 focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-400 dark:hover:text-blue-300"
            >
              {row.original.name}
            </Link>
          ) : (
            <p className="font-medium">{row.original.name}</p>
          )}
          {row.original.description && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    tabIndex={0}
                    className="block w-56 truncate text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                {row.original.description}
              </TooltipTrigger>
              <TooltipContent className="max-w-sm break-words whitespace-normal">
                {row.original.description}
              </TooltipContent>
            </Tooltip>
          )}
        </div>
      ),
    },
    {
      id: "promptCharacters",
      accessorFn: (agent) => agent.configuration?.promptCharacters ?? -1,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Instrucciones" />
      ),
      cell: ({ row }) => {
        const configuration = row.original.configuration
        if (!configuration) return unavailable
        const ready =
          configuration.promptCharacters >= SYSTEM_PROMPT_MIN_CHARACTERS
        return (
          <div className="flex items-center gap-2">
            <Badge
              variant={ready ? "success" : "warning"}
              className="size-6 justify-center p-0"
            >
              {ready ? (
                <CheckIcon className="size-3.5" aria-hidden="true" />
              ) : (
                <XIcon className="size-3.5" aria-hidden="true" />
              )}
              <span className="sr-only">
                {ready ? "Instrucciones listas" : "Instrucciones incompletas"}
              </span>
            </Badge>
            <span className="text-xs text-muted-foreground tabular-nums">
              {configuration.promptCharacters} caracteres
            </span>
          </div>
        )
      },
    },
    counts("skillsCount", "Habilidades"),
    counts("collectionsCount", "Colecciones"),
    counts("toolsCount", "Herramientas", true),
    counts("connectionsCount", "Conexiones", true),
    {
      id: "versions",
      accessorFn: (agent) =>
        agent.configuration?.reviewVersions[0]?.revision ?? -1,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Versiones" />
      ),
      cell: ({ row }) => {
        const configuration = row.original.configuration
        if (!configuration) return unavailable
        return (
          <div className="space-y-2 text-xs">
            <div
              className="flex items-center gap-2"
              aria-label={`Desplegada: ${configuration.liveVersion ?? "ninguna"}`}
            >
              <RocketIcon
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <span>{configuration.liveVersion ?? "Sin desplegar"}</span>
            </div>
            {configuration.reviewVersions.length ? (
              configuration.reviewVersions.map((version, index) => (
                <div
                  key={`${version.version}-${index}`}
                  className="flex items-center gap-2"
                  aria-label={`${version.status === "in_review" ? "En revisión" : "Enviada"}: ${version.version}`}
                >
                  <Clock3Icon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span>{version.version}</span>
                  <Badge
                    variant={version.status === "in_review" ? "sky" : "warning"}
                  >
                    {version.status === "in_review" ? "En revisión" : "Enviada"}
                  </Badge>
                </div>
              ))
            ) : (
              <div className="flex items-center gap-2 text-muted-foreground">
                <Clock3Icon className="size-4 shrink-0" aria-hidden="true" />
                <span>Sin envíos activos</span>
              </div>
            )}
          </div>
        )
      },
    },
    {
      accessorKey: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Estado" />
      ),
      cell: ({ row }) => (
        <Badge variant="outline" className="rounded-full">
          {row.original.status === "draft" ? "Borrador" : row.original.status}
        </Badge>
      ),
    },
  ]
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Los conteos corresponden al borrador guardado. Instrucciones listas: al
        menos {SYSTEM_PROMPT_MIN_CHARACTERS} caracteres sin contar espacios.
        Desliza horizontalmente para ver todas las columnas.
      </p>
      <DataTable
        columns={columns}
        data={agents}
        searchKeys={["name", "description", "slug", "id"]}
      />
    </div>
  )
}
