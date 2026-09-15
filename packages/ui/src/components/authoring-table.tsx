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
import { Badge } from "@workspace/ui/components/badge"
import {
  AgentStatusBadge,
  SubmissionStatusBadge,
} from "@workspace/ui/components/status-badge"
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
        <div className="max-w-56 min-w-32 whitespace-normal">
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
    {
      id: "resources",
      header: "Recursos",
      cell: ({ row }) => {
        const configuration = row.original.configuration
        if (!configuration) return unavailable
        return (
          <div className="flex items-center gap-4">
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
    {
      id: "reviewVersions",
      accessorFn: (agent) =>
        agent.configuration?.reviewVersions[0]?.revision ?? -1,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="En revisión" />
      ),
      cell: ({ row }) => {
        const configuration = row.original.configuration
        if (!configuration) return unavailable
        return (
          <div className="space-y-2 text-xs">
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
                  <SubmissionStatusBadge status={version.status} />
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
      id: "liveVersion",
      accessorFn: (agent) => agent.configuration?.liveVersion ?? "",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Actual" />
      ),
      cell: ({ row }) => {
        const configuration = row.original.configuration
        if (!configuration) return unavailable
        return (
          <div
            className="flex items-center gap-2"
            aria-label={`Versión desplegada: ${configuration.liveVersion ?? "ninguna"}`}
          >
            <RocketIcon
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <span>{configuration.liveVersion ?? "Sin desplegar"}</span>
          </div>
        )
      },
    },
    {
      accessorKey: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Estado" />
      ),
      cell: ({ row }) => <AgentStatusBadge status={row.original.status} />,
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
