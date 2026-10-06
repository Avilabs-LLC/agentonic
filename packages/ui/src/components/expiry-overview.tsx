"use client"
import type { ColumnDef } from "@tanstack/react-table"
import {
  formatUtcMinute as utc,
  formatUtcParts,
} from "@agentonic/contracts/format"
import {
  expiryActorLabels,
  type ExpiryRow,
  type Registration,
  type RuntimeRegistrations,
} from "@agentonic/contracts/expiry"
import {
  deploymentLabels,
  environmentLabels,
} from "@agentonic/contracts/lifecycle"
import {
  deploymentBadgeVariants,
  statusDescriptor,
} from "@workspace/ui/lib/badge-status"
import { Badge } from "@workspace/ui/components/badge"
import { StatusIndicator } from "@workspace/ui/components/status-badge"
import { IdLink } from "@workspace/ui/components/id-link"
import { AgentLink } from "@workspace/ui/components/agent-versions"
import {
  PlaceGroups,
  type PlaceItem,
} from "@workspace/ui/components/place-groups"
import { WorkspaceName } from "@workspace/ui/components/workspace-name"
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

const past = (value: string, now: string) =>
  Date.parse(value) <= Date.parse(now)

// A deadline as plain text; a lapsed one is a nested outcome (§9.1).
function Deadline({ value, now }: { value: string | null; now: string }) {
  if (value === null)
    return <span className="text-muted-foreground">No aplica</span>
  const { date, time } = formatUtcParts(value)
  return (
    <div className="tabular-nums">
      {past(value, now) ? (
        <StatusIndicator
          className="text-xs"
          state={{
            label: `Venció el ${date}`,
            variant: "warning",
            icon: "clock",
          }}
        />
      ) : (
        <p>{date}</p>
      )}
      <p className="text-muted-foreground">{time}</p>
    </div>
  )
}

export function RegistrationsCard({
  registrations,
  now,
}: {
  registrations: RuntimeRegistrations
  now: string
}) {
  const describe = (r: Registration) =>
    ["revoked", "retired"].includes(r.state)
      ? `Verificada el ${utc(r.verifiedAt)}`
      : `${past(r.expiresAt, now) ? "Venció" : "Vence"} el ${utc(r.expiresAt)} · Verificada el ${utc(r.verifiedAt)}`
  const items: PlaceItem[] = [
    ...registrations.hosts.map((r) => ({ name: "Agentes", r })),
    ...registrations.evaluators.map((r) => ({ name: "Evaluaciones", r })),
  ].map(({ name, r }) => ({
    environment: r.environment,
    name,
    description: describe(r),
    action: (
      <StatusIndicator
        appearance="badge"
        state={statusDescriptor("registration", r.state)}
      />
    ),
  }))
  return (
    <Card>
      <CardHeader>
        <CardTitle>Servidores y evaluadores</CardTitle>
        <CardDescription>
          Cada verificación dura siete días y la renueva el equipo de Agentonic
          tras comprobar la instalación. Sin una verificación vigente, los
          agentes o las evaluaciones de ese lugar se detienen.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <CardEmptyState title="Sin servidores registrados">
            Instala y registra un servidor para activar agentes o evaluar
            versiones.
          </CardEmptyState>
        ) : (
          <PlaceGroups items={items} />
        )}
      </CardContent>
    </Card>
  )
}

const time = (value: string | null) =>
  value === null ? Infinity : Date.parse(value)

export function ExpiryTable({ rows, now }: { rows: ExpiryRow[]; now: string }) {
  const columns: ColumnDef<ExpiryRow>[] = [
    {
      accessorKey: "id",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="ID" />
      ),
      cell: ({ row }) => (
        <IdLink
          id={row.original.id}
          href={`/submissions/${row.original.id}/receipt?workspace=${row.original.workspaceId}`}
        />
      ),
    },
    {
      accessorKey: "agentName",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Agente" />
      ),
      cell: ({ row }) => (
        <div className="space-y-1">
          <p className="font-medium">
            {row.original.agentId ? (
              <AgentLink
                href={`/agents/${row.original.agentId}`}
                name={row.original.agentName}
              />
            ) : (
              row.original.agentName
            )}
          </p>
          <p className="flex items-center gap-x-1.5 text-muted-foreground">
            <WorkspaceName name={row.original.workspaceName} />
            <span>· Versión {row.original.versionNumber}</span>
          </p>
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Despliegue" />
      ),
      cell: ({ row }) => (
        <div className="space-y-1">
          <Badge
            variant={deploymentBadgeVariants[row.original.status] ?? "slate"}
          >
            {row.original.status === "unauthorized"
              ? "Autorización no vigente"
              : (deploymentLabels[row.original.status] ?? "Estado desconocido")}
          </Badge>
          {row.original.environment && (
            <p className="text-xs text-muted-foreground">
              {environmentLabels[row.original.environment]}
            </p>
          )}
        </div>
      ),
    },
    {
      id: "approval",
      accessorFn: (row) => time(row.approvalExpiresAt),
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Plazo para activar" />
      ),
      cell: ({ row }) => (
        <Deadline value={row.original.approvalExpiresAt} now={now} />
      ),
    },
    {
      id: "consent",
      accessorFn: (row) => time(row.consentExpiresAt),
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Uso autorizado hasta" />
      ),
      cell: ({ row }) => (
        <Deadline value={row.original.consentExpiresAt} now={now} />
      ),
    },
    {
      id: "host",
      accessorFn: (row) => time(row.host?.expiresAt ?? null),
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title="Servidor verificado hasta"
        />
      ),
      cell: ({ row }) =>
        row.original.host?.state === "revoked" ? (
          <StatusIndicator
            className="text-xs"
            state={statusDescriptor("registration", "revoked")}
          />
        ) : (
          <Deadline value={row.original.host?.expiresAt ?? null} now={now} />
        ),
    },
    {
      id: "next",
      accessorFn: (row) => time(row.next.by),
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Próximo paso" />
      ),
      cell: ({ row }) => {
        const { actor, action, by } = row.original.next
        return (
          <div>
            <p className="font-medium">
              {actor ? `${expiryActorLabels[actor]} · ${action}` : action}
            </p>
            {by && (
              <p className="text-muted-foreground">
                {past(by, now) ? "Venció el" : "Antes del"} {utc(by)}
              </p>
            )}
          </div>
        )
      },
    },
  ]
  return (
    <DataTable
      data={rows}
      columns={columns}
      searchKeys={["agentName", "workspaceName"]}
      searchLabel="Buscar agentes o espacios"
      emptyDescription="Ninguna versión aprobada tiene plazos pendientes."
      getRowId={(row) => row.id}
    />
  )
}
