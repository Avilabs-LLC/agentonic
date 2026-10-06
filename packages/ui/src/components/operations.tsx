"use client"
// Admin operations screens (architecture §52): agents, activity, workspaces,
// deployments, costs and runtime releases. Metadata only; one badge per row
// for the record's primary state, nested states inline (UI contract §9).
import type { Column, ColumnDef } from "@tanstack/react-table"
import {
  formatCount,
  formatMoney,
  formatUtcMinute as utc,
  formatUtcParts,
} from "@agentonic/contracts/format"
import { registrationNames } from "@agentonic/contracts/expiry"
import {
  deploymentLabels,
  environmentLabels,
} from "@agentonic/contracts/lifecycle"
import {
  auditActionLabels,
  auditActorLabels,
  auditResourceLabels,
  providerLabels,
  staffRoleLabels,
  workspaceKindLabels,
  type OperationsAgent,
  type OperationsCostDay,
  type OperationsDeployment,
  type OperationsEvent,
  type OperationsRelease,
  type OperationsWorkspace,
} from "@agentonic/contracts/operations"
import {
  deploymentBadgeVariants,
  statusDescriptor,
} from "@workspace/ui/lib/badge-status"
import { Badge } from "@workspace/ui/components/badge"
import { StatusIndicator } from "@workspace/ui/components/status-badge"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import {
  DataTable,
  DataTableColumnHeader,
} from "@workspace/ui/components/data-table"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemSeparator,
  ItemTitle,
} from "@workspace/ui/components/item"

/** A sortable header with this title, for any column. */
function header<T>(title: string) {
  function SortableHeader({ column }: { column: Column<T, unknown> }) {
    return <DataTableColumnHeader column={column} title={title} />
  }
  return SortableHeader
}
function When({ value }: { value: string | null }) {
  if (value === null)
    return <span className="text-muted-foreground">Sin registro</span>
  const { date, time } = formatUtcParts(value)
  return (
    <div className="tabular-nums">
      <p>{date}</p>
      <p className="text-muted-foreground">{time}</p>
    </div>
  )
}
const at = (value: string | null) =>
  value === null ? -Infinity : Date.parse(value)
function Named({ name, detail }: { name: string; detail: string }) {
  return (
    <div className="max-w-64 min-w-40 whitespace-normal">
      <p className="font-medium">{name}</p>
      <p className="text-muted-foreground">{detail}</p>
    </div>
  )
}
function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="text-xs font-medium tracking-wide uppercase">
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">
          {formatCount(value)}
        </CardTitle>
      </CardHeader>
    </Card>
  )
}

// Agentes -------------------------------------------------------------------------
function capabilities(tools: OperationsAgent["tools"]) {
  const parts = [
    ...(tools.collections
      ? [
          `Conocimiento (${formatCount(tools.collections)} ${tools.collections === 1 ? "colección" : "colecciones"})`,
        ]
      : []),
    ...(tools.gmail ? ["Gmail"] : []),
    ...(tools.web ? ["Web"] : []),
  ]
  return parts.length ? parts.join(" · ") : "Sin herramientas ni conocimiento"
}
export function OperationsAgentsTable({
  agents,
}: {
  agents: OperationsAgent[]
}) {
  const columns: ColumnDef<OperationsAgent>[] = [
    {
      accessorKey: "name",
      header: header("Agente"),
      cell: ({ row }) => (
        <Named name={row.original.name} detail={row.original.workspaceName} />
      ),
    },
    {
      accessorKey: "ownerName",
      header: header("Responsable"),
    },
    {
      id: "capabilities",
      accessorFn: (row) => capabilities(row.tools),
      header: header("Capacidades de la última versión"),
      cell: ({ row }) => (
        <div className="max-w-60 min-w-40 whitespace-normal">
          <p>{capabilities(row.original.tools)}</p>
          <p className="text-muted-foreground">
            {row.original.latestVersion
              ? `Versión ${row.original.latestVersion}`
              : "Sin versiones congeladas"}
          </p>
        </div>
      ),
    },
    {
      id: "deployment",
      accessorFn: (row) => row.deployment?.status ?? "none",
      header: header("Despliegue"),
      cell: ({ row }) => {
        const d = row.original.deployment
        return (
          <div className="space-y-1">
            <StatusIndicator
              className="text-sm"
              state={statusDescriptor("deployment", d?.status ?? "none")}
            />
            {d && (
              <p className="text-xs text-muted-foreground">
                {environmentLabels[d.environment]}
                {d.resting && d.status === "running" ? " · En reposo" : ""}
              </p>
            )}
          </div>
        )
      },
    },
    {
      id: "activity",
      accessorFn: (row) => at(row.lastRunAt),
      header: header("Último turno"),
      cell: ({ row }) => (
        <div className="tabular-nums">
          <When value={row.original.lastRunAt} />
          <p className="text-xs text-muted-foreground">
            {formatCount(row.original.runs7d)} en 7 días
          </p>
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: header("Estado"),
      cell: ({ row }) => (
        <StatusIndicator
          appearance="badge"
          state={statusDescriptor("agent", row.original.status)}
        />
      ),
    },
  ]
  return (
    <DataTable
      data={agents}
      columns={columns}
      searchKeys={["name", "workspaceName", "ownerName"]}
      searchLabel="Buscar agentes, espacios o responsables"
      emptyDescription="Todavía no hay agentes en ningún espacio de trabajo."
      getRowId={(row) => row.id}
    />
  )
}

// Actividad -----------------------------------------------------------------------
export function OperationsActivityStats({
  runs,
  awaitingApproval,
  reads24h,
}: {
  runs: { succeeded: number; failed: number; active: number }
  awaitingApproval: number
  reads24h: number
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
      <Stat label="Turnos completados (24 h)" value={runs.succeeded} />
      <Stat label="Turnos fallidos (24 h)" value={runs.failed} />
      <Stat label="Turnos en curso" value={runs.active} />
      <Stat label="Escrituras por confirmar" value={awaitingApproval} />
      <Stat label="Consultas (24 h)" value={reads24h} />
    </div>
  )
}
type ActivityRow = OperationsEvent & { actionLabel: string }
export function OperationsActivityTable({
  events,
}: {
  events: OperationsEvent[]
}) {
  const rows: ActivityRow[] = events.map((e) => ({
    ...e,
    actionLabel: auditActionLabels[e.action] ?? e.action,
  }))
  const columns: ColumnDef<ActivityRow>[] = [
    {
      id: "at",
      accessorFn: (row) => at(row.at),
      header: header("Fecha"),
      cell: ({ row }) => <When value={row.original.at} />,
    },
    { accessorKey: "workspaceName", header: header("Espacio de trabajo") },
    {
      accessorKey: "actionLabel",
      header: header("Acción"),
      cell: ({ row }) => (
        <div className="max-w-64 min-w-40 whitespace-normal">
          <p className="font-medium">{row.original.actionLabel}</p>
          <p className="text-muted-foreground">
            {auditResourceLabels[row.original.resourceType] ??
              row.original.resourceType}{" "}
            <span className="font-mono text-xs">{row.original.resourceId}</span>
          </p>
        </div>
      ),
    },
    {
      accessorKey: "actor",
      header: header("Quién"),
      cell: ({ row }) => auditActorLabels[row.original.actor],
    },
    {
      accessorKey: "outcome",
      header: header("Resultado"),
      cell: ({ row }) => (
        <StatusIndicator
          className="text-sm"
          state={statusDescriptor("outcome", row.original.outcome)}
        />
      ),
    },
  ]
  return (
    <DataTable
      data={rows}
      columns={columns}
      searchKeys={["actionLabel", "workspaceName", "resourceId"]}
      searchLabel="Buscar acciones o espacios"
      emptyDescription="No hay cambios registrados."
      getRowId={(row) => row.id}
    />
  )
}

// Espacios de trabajo --------------------------------------------------------------
export function OperationsWorkspacesTable({
  workspaces,
}: {
  workspaces: OperationsWorkspace[]
}) {
  const columns: ColumnDef<OperationsWorkspace>[] = [
    {
      accessorKey: "name",
      header: header("Espacio de trabajo"),
      cell: ({ row }) => (
        <Named
          name={row.original.name}
          detail={`${workspaceKindLabels[row.original.kind] ?? row.original.kind} · ${row.original.timezone}`}
        />
      ),
    },
    {
      accessorKey: "members",
      header: header("Miembros activos"),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatCount(row.original.members)}
        </span>
      ),
    },
    {
      accessorKey: "agents",
      header: header("Agentes"),
      cell: ({ row }) => (
        <span className="tabular-nums">{formatCount(row.original.agents)}</span>
      ),
    },
    {
      accessorKey: "pendingInvitations",
      header: header("Invitaciones pendientes"),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatCount(row.original.pendingInvitations)}
        </span>
      ),
    },
    {
      id: "createdAt",
      accessorFn: (row) => at(row.createdAt),
      header: header("Creado"),
      cell: ({ row }) => <When value={row.original.createdAt} />,
    },
    {
      accessorKey: "status",
      header: header("Estado"),
      cell: ({ row }) => (
        <StatusIndicator
          appearance="badge"
          state={statusDescriptor("workspace", row.original.status)}
        />
      ),
    },
  ]
  return (
    <DataTable
      data={workspaces}
      columns={columns}
      searchKeys={["name"]}
      searchLabel="Buscar espacios de trabajo"
      emptyDescription="No hay espacios de trabajo."
      getRowId={(row) => row.id}
    />
  )
}
export function OperationsStaffCard({
  staff,
}: {
  staff: {
    name: string
    role: string
    status: "active" | "disabled"
    since: string
  }[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Equipo de Agentonic</CardTitle>
        <CardDescription>
          Personas con acceso a este panel. Su acceso al contenido de un cliente
          requiere el permiso de ese cliente para cada revisión.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {staff.length === 0 ? (
          <CardEmptyState title="Sin personal registrado">
            Registra al personal con los scripts de configuración.
          </CardEmptyState>
        ) : (
          <ItemGroup>
            {staff.map((person, index) => (
              <div key={`${person.name}-${index}`}>
                {index > 0 && <ItemSeparator className="my-0" />}
                <Item size="sm" className="px-0">
                  <ItemContent>
                    <ItemTitle>{person.name}</ItemTitle>
                    <ItemDescription>
                      {staffRoleLabels[person.role] ?? person.role} · Desde el{" "}
                      {formatUtcParts(person.since).date}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <StatusIndicator
                      appearance="badge"
                      state={statusDescriptor("staff", person.status)}
                    />
                  </ItemActions>
                </Item>
              </div>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  )
}

// Despliegues ---------------------------------------------------------------------
type Runtime = { version: string; commit: string | null }
const runtimesText = (runtimes: Runtime[]) =>
  runtimes.length
    ? runtimes
        .map((r) =>
          r.commit && !r.version.includes(r.commit)
            ? `${r.version} (${r.commit})`
            : r.version
        )
        .join(", ")
    : "ninguno"
export function OperationsInstallationsCard({
  hosts,
  evaluators,
}: {
  hosts: {
    environment: "local" | "azure_staging"
    state: string
    heartbeatAt: string | null
    current: string
    workers: string[]
    runtimes: Runtime[]
  }[]
  evaluators: {
    environment: "local" | "azure_staging"
    state: string
    current: string
    toolFixtures: boolean
    runtimes: Runtime[]
  }[]
}) {
  const items = [
    ...hosts.map((h) => ({
      key: `host-${h.environment}`,
      name: registrationNames.host[h.environment],
      state: h.state,
      description: `Trabajador ${h.current}${h.workers.length > 1 ? ` (en servicio: ${h.workers.join(", ")})` : ""} · Runtimes ${runtimesText(h.runtimes)} · ${h.heartbeatAt ? `Último reporte el ${utc(h.heartbeatAt)}` : "Sin reportes"}`,
    })),
    ...evaluators.map((e) => ({
      key: `evaluator-${e.environment}`,
      name: registrationNames.evaluator[e.environment],
      state: e.state,
      description: `Evaluador ${e.current} · Runtimes ${runtimesText(e.runtimes)} · ${e.toolFixtures ? "Prueba herramientas con datos sintéticos" : "Sin pruebas de herramientas"}`,
    })),
  ]
  return (
    <Card>
      <CardHeader>
        <CardTitle>Qué ejecuta cada servidor</CardTitle>
        <CardDescription>
          Versiones del trabajador y del runtime instaladas, como las informa
          la verificación dos veces al día. Instalar una versión nueva se hace
          desde el Mac con los scripts de instalación.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <CardEmptyState title="Sin servidores registrados">
            Instala y registra un servidor para activar agentes o evaluar
            versiones.
          </CardEmptyState>
        ) : (
          <ItemGroup>
            {items.map((item, index) => (
              <div key={item.key}>
                {index > 0 && <ItemSeparator className="my-0" />}
                <Item size="sm" className="px-0">
                  <ItemContent>
                    <ItemTitle>{item.name}</ItemTitle>
                    <ItemDescription className="whitespace-normal">
                      {item.description}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <StatusIndicator
                      appearance="badge"
                      state={statusDescriptor("registration", item.state)}
                    />
                  </ItemActions>
                </Item>
              </div>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  )
}
export function OperationsDeploymentsTable({
  deployments,
}: {
  deployments: OperationsDeployment[]
}) {
  const columns: ColumnDef<OperationsDeployment>[] = [
    {
      accessorKey: "agentName",
      header: header("Agente"),
      cell: ({ row }) => (
        <Named
          name={row.original.agentName}
          detail={row.original.workspaceName}
        />
      ),
    },
    {
      accessorKey: "environment",
      header: header("Entorno"),
      cell: ({ row }) => (
        <div>
          <p>{environmentLabels[row.original.environment]}</p>
          <p className="font-mono text-xs text-muted-foreground">
            {row.original.broker ?? "Sin trabajador"}
          </p>
        </div>
      ),
    },
    {
      id: "authorizedUntil",
      accessorFn: (row) => at(row.authorizedUntil),
      header: header("Uso autorizado hasta"),
      cell: ({ row }) => <When value={row.original.authorizedUntil} />,
    },
    {
      id: "spent",
      accessorFn: (row) => row.spentUsd,
      header: header("Gasto"),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatMoney(row.original.spentUsd)} de{" "}
          {formatMoney(row.original.budgetUsd)}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: header("Estado"),
      cell: ({ row }) => (
        <div className="space-y-1">
          <Badge
            variant={deploymentBadgeVariants[row.original.status] ?? "slate"}
          >
            {deploymentLabels[row.original.status] ?? "Estado desconocido"}
          </Badge>
          {row.original.resting && row.original.status === "running" && (
            <p className="text-xs text-muted-foreground">En reposo</p>
          )}
        </div>
      ),
    },
  ]
  return (
    <DataTable
      data={deployments}
      columns={columns}
      searchKeys={["agentName", "workspaceName"]}
      searchLabel="Buscar agentes o espacios"
      emptyDescription="No hay despliegues."
      getRowId={(row) => row.id}
    />
  )
}

// Costos --------------------------------------------------------------------------
export function OperationsProvidersCard({
  providers,
}: {
  providers: {
    provider: string
    capUsd: number
    committedUsd: number
    settledUsd: number
    unknownOperations: number
  }[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Límites de gasto por proveedor</CardTitle>
        <CardDescription>
          Lo comprometido incluye lo ya pagado y las reservas cuyo resultado no
          se conoce; una reserva sin resultado nunca se cuenta como cero. El
          uso acumulado no se reinicia.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ItemGroup>
          {providers.map((p, index) => (
            <div key={p.provider}>
              {index > 0 && <ItemSeparator className="my-0" />}
              <Item size="sm" className="px-0">
                <ItemContent>
                  <ItemTitle>{providerLabels[p.provider] ?? p.provider}</ItemTitle>
                  <ItemDescription className="tabular-nums">
                    Comprometido {formatMoney(p.committedUsd)} de{" "}
                    {formatMoney(p.capUsd)} · Liquidado{" "}
                    {formatMoney(p.settledUsd)}
                  </ItemDescription>
                </ItemContent>
                {p.unknownOperations > 0 && (
                  <ItemActions>
                    <StatusIndicator
                      className="text-sm"
                      state={{
                        label: `${formatCount(p.unknownOperations)} sin resultado conocido`,
                        variant: "warning",
                        icon: "alert",
                      }}
                    />
                  </ItemActions>
                )}
              </Item>
            </div>
          ))}
        </ItemGroup>
      </CardContent>
    </Card>
  )
}
export function OperationsCostsTable({ days }: { days: OperationsCostDay[] }) {
  const columns: ColumnDef<OperationsCostDay>[] = [
    {
      accessorKey: "date",
      header: header("Día"),
      cell: ({ row }) => (
        <div className="tabular-nums">
          <p>{row.original.date.split("-").reverse().join("/")}</p>
          <p className="text-muted-foreground">{row.original.timezone}</p>
        </div>
      ),
    },
    { accessorKey: "workspaceName", header: header("Espacio de trabajo") },
    {
      accessorKey: "knownUsd",
      header: header("Gasto conocido"),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatMoney(row.original.knownUsd)}
        </span>
      ),
    },
    {
      accessorKey: "unknownOperations",
      header: header("Sin resultado conocido"),
      cell: ({ row }) =>
        row.original.unknownOperations > 0 ? (
          <StatusIndicator
            className="text-sm"
            state={{
              label: `${formatCount(row.original.unknownOperations)} operaciones`,
              variant: "warning",
              icon: "alert",
            }}
          />
        ) : (
          <span className="text-muted-foreground">Ninguna</span>
        ),
    },
  ]
  return (
    <DataTable
      data={days}
      columns={columns}
      searchKeys={["workspaceName", "date"]}
      searchLabel="Buscar espacios o fechas"
      emptyDescription="No hay gasto registrado en los últimos 30 días."
      getRowId={(row) => `${row.date}-${row.workspaceId}`}
    />
  )
}
export function OperationsTopAgentsCard({
  agents,
}: {
  agents: {
    agentName: string
    workspaceName: string
    knownUsd: number
    operations: number
  }[]
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agentes con más gasto (30 días)</CardTitle>
        <CardDescription>
          Gasto directo de cada agente. El gasto compartido de procesar
          documentos se cuenta una sola vez, en su espacio de trabajo.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {agents.length === 0 ? (
          <CardEmptyState title="Sin gasto de agentes">
            Aparecerá cuando un agente responda en una prueba, una evaluación o
            un despliegue.
          </CardEmptyState>
        ) : (
          <ItemGroup>
            {agents.map((agent, index) => (
              <div key={`${agent.workspaceName}-${agent.agentName}-${index}`}>
                {index > 0 && <ItemSeparator className="my-0" />}
                <Item size="sm" className="px-0">
                  <ItemContent>
                    <ItemTitle>{agent.agentName}</ItemTitle>
                    <ItemDescription>
                      {agent.workspaceName} ·{" "}
                      {formatCount(agent.operations)} operaciones
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions className="tabular-nums">
                    {formatMoney(agent.knownUsd)}
                  </ItemActions>
                </Item>
              </div>
            ))}
          </ItemGroup>
        )}
      </CardContent>
    </Card>
  )
}

// Runtime -------------------------------------------------------------------------
type ReleaseRow = OperationsRelease & { installed: string }
export function OperationsReleasesTable({
  releases,
}: {
  releases: OperationsRelease[]
}) {
  const rows: ReleaseRow[] = releases.map((r) => ({
    ...r,
    installed:
      [
        ...r.hosts.map((h) => registrationNames.host[h]),
        ...r.evaluators.map((e) => registrationNames.evaluator[e]),
      ].join(" · ") || "Sin instalar",
  }))
  const columns: ColumnDef<ReleaseRow>[] = [
    {
      accessorKey: "version",
      header: header("Versión"),
      cell: ({ row }) => (
        <div>
          <p className="font-medium">{row.original.version}</p>
          <p className="font-mono text-xs text-muted-foreground">
            Commit {row.original.commit} · {row.original.artifact}
          </p>
        </div>
      ),
    },
    {
      accessorKey: "installed",
      header: header("Instalada en"),
      cell: ({ row }) => (
        <p className="max-w-72 min-w-48 whitespace-normal">
          {row.original.installed}
        </p>
      ),
    },
    {
      accessorKey: "workspaces",
      header: header("Espacios con acceso"),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatCount(row.original.workspaces)}
        </span>
      ),
    },
    {
      id: "createdAt",
      accessorFn: (row) => at(row.createdAt),
      header: header("Publicada"),
      cell: ({ row }) => <When value={row.original.createdAt} />,
    },
    {
      accessorKey: "status",
      header: header("Estado"),
      cell: ({ row }) => (
        <StatusIndicator
          appearance="badge"
          state={statusDescriptor("release", row.original.status)}
        />
      ),
    },
  ]
  return (
    <DataTable
      data={rows}
      columns={columns}
      searchKeys={["version", "commit", "artifact"]}
      searchLabel="Buscar versiones o commits"
      emptyDescription="No hay versiones del runtime publicadas."
      getRowId={(row) => row.id}
    />
  )
}
