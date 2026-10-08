"use client"
import type { ColumnDef } from "@tanstack/react-table"
import { formatUtcMinute as utc } from "@agentonic/contracts/format"
import {
  expiryActorLabels,
  type ExpiryRow,
  type Registration,
  type RuntimeRegistrations,
} from "@agentonic/contracts/expiry"
import { environmentLabels } from "@agentonic/contracts/lifecycle"
import { statusDescriptor } from "@workspace/ui/lib/badge-status"
import { StatusIndicator } from "@workspace/ui/components/status-badge"
import {
  Absent,
  CellLink,
  Count,
  Deadline,
  sortableHeader,
} from "@workspace/ui/components/table-cells"
import { AgentLink } from "@workspace/ui/components/agent-versions"
import {
  PlaceGroups,
  type PlaceItem,
} from "@workspace/ui/components/place-groups"
import { WorkspaceName } from "@workspace/ui/components/workspace-name"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import { DataTable } from "@workspace/ui/components/data-table"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@workspace/ui/components/card"

const past = (value: string, now: string) =>
  Date.parse(value) <= Date.parse(now)

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
          Cada verificación dura 30 días y el equipo de Agentonic la renueva
          cada semana tras comprobar la instalación. Sin una verificación
          vigente, los agentes o las evaluaciones de ese lugar se detienen.
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
  const header = sortableHeader<ExpiryRow>
  const columns: ColumnDef<ExpiryRow>[] = [
    {
      accessorKey: "agentName",
      header: header("Agente"),
      cell: ({ row }) =>
        row.original.agentId ? (
          <AgentLink
            href={`/agents/${row.original.agentId}`}
            name={row.original.agentName}
          />
        ) : (
          row.original.agentName
        ),
    },
    {
      accessorKey: "workspaceName",
      header: header("Espacio", "Espacio de trabajo"),
      cell: ({ row }) => <WorkspaceName name={row.original.workspaceName} />,
    },
    {
      accessorKey: "versionNumber",
      header: header("Versión"),
      cell: ({ row }) => <Count value={row.original.versionNumber} />,
    },
    {
      accessorKey: "number",
      header: header("Revisión"),
      // As in Revisiones, the review number opens its approval receipt.
      cell: ({ row }) => (
        <CellLink
          href={`/submissions/${row.original.id}/receipt?workspace=${row.original.workspaceId}`}
          className="tabular-nums"
        >
          <span className="sr-only">Ver comprobante de la revisión </span>
          {row.original.number}
        </CellLink>
      ),
    },
    {
      id: "environment",
      accessorFn: (row) =>
        row.environment ? environmentLabels[row.environment] : "",
      header: header("Entorno"),
      cell: ({ row }) =>
        row.original.environment ? (
          environmentLabels[row.original.environment]
        ) : (
          <Absent>No aplica</Absent>
        ),
    },
    {
      accessorKey: "status",
      header: header("Despliegue"),
      cell: ({ row }) =>
        row.original.status === "none" ? (
          <Absent>Sin despliegue</Absent>
        ) : (
          <StatusIndicator
            appearance="badge"
            state={statusDescriptor("deployment", row.original.status)}
          />
        ),
    },
    {
      id: "approval",
      accessorFn: (row) => time(row.approvalExpiresAt),
      header: header("Activar hasta", "Plazo para activar"),
      cell: ({ row }) => (
        <Deadline value={row.original.approvalExpiresAt} now={now} />
      ),
    },
    {
      id: "consent",
      accessorFn: (row) => time(row.consentExpiresAt),
      header: header("Uso hasta", "Uso autorizado hasta"),
      cell: ({ row }) => (
        <Deadline value={row.original.consentExpiresAt} now={now} />
      ),
    },
    {
      id: "host",
      accessorFn: (row) => time(row.host?.expiresAt ?? null),
      header: header("Servidor hasta", "Servidor verificado hasta"),
      cell: ({ row }) =>
        row.original.host?.state === "revoked" ? (
          <StatusIndicator
            state={statusDescriptor("registration", "revoked")}
          />
        ) : (
          <Deadline value={row.original.host?.expiresAt ?? null} now={now} />
        ),
    },
    {
      id: "next",
      // Sorted by urgency; its deadline is the earliest one in this row.
      accessorFn: (row) => time(row.next.by),
      header: header("Próximo paso"),
      cell: ({ row }) => {
        const { actor, action } = row.original.next
        return actor ? `${expiryActorLabels[actor]} · ${action}` : action
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
