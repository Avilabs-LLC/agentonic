"use client"
import { Fragment } from "react"
import type { ColumnDef } from "@tanstack/react-table"
import { formatUtcParts } from "@agentonic/contracts/format"
import {
  expiryActorLabels,
  type ExpiryRow,
  type Registration,
  type RuntimeRegistrations,
} from "@agentonic/contracts/expiry"
import { environmentLabels } from "@agentonic/contracts/lifecycle"
import { statusDescriptor } from "@workspace/ui/lib/badge-status"
import {
  iconTones,
  StatusIndicator,
} from "@workspace/ui/components/status-badge"
import {
  Absent,
  CellLink,
  VersionNumber,
  Deadline,
  sortableHeader,
} from "@workspace/ui/components/table-cells"
import { AgentLink } from "@workspace/ui/components/agent-versions"
import { MetricTile } from "@workspace/ui/components/metric-tile"
import {
  LocalServersDialog,
  registrationValue,
  ServerTilesGrid,
  unregistered,
  type Environment,
} from "@workspace/ui/components/server-tiles"
import { WorkspaceName } from "@workspace/ui/components/workspace-name"
import { DataTable } from "@workspace/ui/components/data-table"

const past = (value: string, now: string) =>
  Date.parse(value) <= Date.parse(now)

// The deadline as the table's Deadline cell shows it: the date, in warning
// once it has passed, then the time. Revoked and retired verifications have
// none.
function deadline(r: Registration | undefined, now: string) {
  if (!r) return { ...unregistered, detail: null }
  if (["revoked", "retired"].includes(r.state))
    return { value: "No aplica", tone: unregistered.tone, detail: null }
  const { date, time } = formatUtcParts(r.expiresAt)
  return past(r.expiresAt, now)
    ? { value: `Venció el ${date}`, tone: iconTones.warning, detail: time }
    : { value: date, detail: time }
}
// One place's verifications as four tiles: each kind's state with its last
// verification, then its deadline. Vencimientos shows vm-agents-01; Local
// (desarrollo) opens from the page header.
export function RegistrationTiles({
  registrations,
  now,
  environment,
  compact = false,
}: {
  registrations: RuntimeRegistrations
  now: string
  environment: Environment
  /** Two columns, for the Local (desarrollo) dialog. */
  compact?: boolean
}) {
  const kinds = [
    { name: "agentes", r: registrations.hosts },
    { name: "evaluaciones", r: registrations.evaluators },
  ].map(({ name, r }) => ({
    name,
    r: r.find((x) => x.environment === environment),
  }))
  return (
    <ServerTilesGrid compact={compact}>
      {kinds.map(({ name, r }) => (
        <Fragment key={name}>
          <MetricTile
            label={`Servidor de ${name}`}
            {...registrationValue(r?.state)}
            detail={
              r ? `Verificada el ${formatUtcParts(r.verifiedAt).date}` : null
            }
          />
          <MetricTile label={`Vencimiento de ${name}`} {...deadline(r, now)} />
        </Fragment>
      ))}
    </ServerTilesGrid>
  )
}
// Local (desarrollo) behind a button at the end of Vencimientos' header.
export function LocalRegistrations({
  registrations,
  now,
}: {
  registrations: RuntimeRegistrations
  now: string
}) {
  const local = (r: Registration) => r.environment === "local"
  return (
    <LocalServersDialog
      registered={
        registrations.hosts.some(local) || registrations.evaluators.some(local)
      }
      description="Verificación del entorno local. Cada una dura 30 días; sin una vigente, los agentes o las evaluaciones de este entorno se detienen."
    >
      <RegistrationTiles
        registrations={registrations}
        now={now}
        environment="local"
        compact
      />
    </LocalServersDialog>
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
      cell: ({ row }) => <VersionNumber value={row.original.versionNumber} />,
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
