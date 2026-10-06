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

// Grouped by place, the VM first: every registration stays visible, since
// a lapsed one stops agents or evaluations there.
const places = [
  { environment: "azure_staging", title: "VM de pruebas" },
  { environment: "local", title: "Local (desarrollo)" },
] as const
export function RegistrationsCard({
  registrations,
  now,
}: {
  registrations: RuntimeRegistrations
  now: string
}) {
  const groups = places
    .map((place) => ({
      ...place,
      items: [
        ...registrations.hosts
          .filter((r) => r.environment === place.environment)
          .map((r) => ({ name: "Agentes", ...r })),
        ...registrations.evaluators
          .filter((r) => r.environment === place.environment)
          .map((r) => ({ name: "Evaluaciones", ...r })),
      ],
    }))
    .filter((group) => group.items.length > 0)
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
        {groups.length === 0 ? (
          <CardEmptyState title="Sin servidores registrados">
            Instala y registra un servidor para activar agentes o evaluar
            versiones.
          </CardEmptyState>
        ) : (
          <div className="grid gap-6 md:grid-cols-2">
            {groups.map((group) => (
              <section
                key={group.environment}
                aria-labelledby={`registrations-${group.environment}`}
                className="space-y-1"
              >
                <h3
                  id={`registrations-${group.environment}`}
                  className="text-xs font-medium tracking-wide text-muted-foreground uppercase"
                >
                  {group.title}
                </h3>
                <ItemGroup>
                  {group.items.map((item, index) => (
                    <RegistrationItem
                      key={item.name}
                      name={item.name}
                      registration={item}
                      now={now}
                      separated={index > 0}
                    />
                  ))}
                </ItemGroup>
              </section>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RegistrationItem({
  name,
  registration,
  now,
  separated,
}: {
  name: string
  registration: Registration
  now: string
  separated: boolean
}) {
  const ended = ["revoked", "retired"].includes(registration.state)
  return (
    <>
      {separated && <ItemSeparator className="my-0" />}
      <Item size="sm" className="px-0">
        <ItemContent>
          <ItemTitle>{name}</ItemTitle>
          <ItemDescription>
            {ended
              ? `Verificada el ${utc(registration.verifiedAt)}`
              : `${past(registration.expiresAt, now) ? "Venció" : "Vence"} el ${utc(registration.expiresAt)} · Verificada el ${utc(registration.verifiedAt)}`}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <StatusIndicator
            appearance="badge"
            state={statusDescriptor("registration", registration.state)}
          />
        </ItemActions>
      </Item>
    </>
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
        <div className="max-w-64 min-w-40 whitespace-normal">
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
          <p className="text-muted-foreground">
            {row.original.workspaceName} · Versión {row.original.versionNumber}
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
          <div className="max-w-72 min-w-52 whitespace-normal">
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
