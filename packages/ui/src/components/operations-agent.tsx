"use client"
// The Admin agent page (architecture §55): what is in use and what comes next,
// then the agent's proposals, deployments and activity. Metadata only; a
// proposal's content stays behind its review and receipt.
import Link from "next/link"
import type { Column, ColumnDef } from "@tanstack/react-table"
import {
  formatCount,
  formatMoney,
  formatUtcMinute as utc,
  formatUtcParts,
} from "@agentonic/contracts/format"
import { submissionLabels } from "@agentonic/contracts/authoring"
import {
  approvalLabels,
  deploymentLabels,
  environmentLabels,
} from "@agentonic/contracts/lifecycle"
import type { OperationsAgentDetail } from "@agentonic/contracts/operations"
import { agentVersionsView } from "@workspace/ui/lib/agent-versions"
import {
  deploymentBadgeVariants,
  statusDescriptor,
  submissionBadgeVariants,
} from "@workspace/ui/lib/badge-status"
import { Badge } from "@workspace/ui/components/badge"
import {
  deploymentResting,
  restingColumn,
} from "@workspace/ui/components/resting-column"
import { cn } from "@workspace/ui/lib/utils"
import {
  iconTones,
  StatusIndicator,
} from "@workspace/ui/components/status-badge"
import { facetTitles } from "@workspace/ui/components/agent-versions"
import { capabilities } from "@workspace/ui/components/operations"
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
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@workspace/ui/components/tabs"

type Proposal = OperationsAgentDetail["proposals"][number] & {
  label: string
  statusLabel: string
}
type Deployment = OperationsAgentDetail["deployments"][number] & {
  environmentLabel: string
  statusLabel: string
}
const linkClass =
  "text-blue-600 underline underline-offset-4 outline-none hover:text-blue-800 focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-400 dark:hover:text-blue-300"

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
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="text-xs font-medium tracking-wide uppercase">
          {label}
        </CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
    </Card>
  )
}
// A metric tile: label, prominent value, detail. Every tile keeps all three
// rows (a placeholder when a detail is missing) so their text lines up; the
// value takes its state's colour instead of a badge.
function Metric({
  label,
  value,
  tone,
  detail,
}: {
  label: string
  value: string
  tone?: string
  detail: string | null
}) {
  return (
    <Card>
      <CardHeader>
        <CardDescription className="text-xs font-medium tracking-wide uppercase">
          {label}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-1">
        <p
          className={cn(
            "truncate text-lg leading-snug font-semibold",
            tone ?? "text-foreground"
          )}
          title={value}
        >
          {value}
        </p>
        <p
          className="truncate text-xs text-muted-foreground"
          title={detail ?? undefined}
        >
          {detail ?? "—"}
        </p>
      </CardContent>
    </Card>
  )
}
function TabLabel({ title, count }: { title: string; count?: number }) {
  return (
    <>
      {title}
      {count !== undefined && (
        <span className="text-muted-foreground tabular-nums">
          {formatCount(count)}
        </span>
      )}
    </>
  )
}

export function OperationsAgentOverview({
  agent,
}: {
  agent: OperationsAgentDetail
}) {
  const view = agentVersionsView(agent.summary)
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(["live", "next"] as const).map((facet) => {
          const f = view[facet]
          return (
            <Metric
              key={facet}
              label={facetTitles[facet]}
              value={f.state?.label ?? "Ninguna"}
              tone={f.state ? iconTones[f.state.variant] : undefined}
              detail={
                f.state
                  ? `${f.detail}${facet === "live" && view.resting ? " · En reposo" : ""}${f.more.length ? ` · y ${f.more.length} más` : ""}`
                  : facet === "live"
                    ? "Ninguna versión en funcionamiento"
                    : f.detail
              }
            />
          )
        })}
        <Metric
          label="Capacidades de la última versión"
          value={capabilities(agent.tools)}
          detail={
            agent.latestVersion
              ? `Versión ${agent.latestVersion}`
              : "Sin versiones congeladas"
          }
        />
      </div>
      <Tabs defaultValue="propuestas" className="gap-6">
        <TabsList variant="line" className="w-full justify-start border-b">
          <TabsTrigger value="propuestas" className="flex-none px-4">
            <TabLabel title="Propuestas" count={agent.proposals.length} />
          </TabsTrigger>
          <TabsTrigger value="despliegues" className="flex-none px-4">
            <TabLabel title="Despliegues" count={agent.deployments.length} />
          </TabsTrigger>
          <TabsTrigger value="actividad" className="flex-none px-4">
            <TabLabel title="Actividad" />
          </TabsTrigger>
        </TabsList>
        <TabsContent value="propuestas">
          <ProposalsTable
            proposals={agent.proposals}
            workspaceId={agent.workspaceId}
          />
        </TabsContent>
        <TabsContent value="despliegues">
          <DeploymentsTable deployments={agent.deployments} />
        </TabsContent>
        <TabsContent value="actividad">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              label="Último turno"
              value={
                agent.activity.lastRunAt
                  ? formatUtcParts(agent.activity.lastRunAt).date
                  : "Sin registro"
              }
            />
            <Stat
              label="Turnos (7 días)"
              value={formatCount(agent.activity.runs7d)}
            />
            <Stat
              label="Turnos fallidos (7 días)"
              value={formatCount(agent.activity.failed7d)}
            />
            <Stat
              label="Gasto conocido (30 días)"
              value={formatMoney(agent.activity.knownUsd30d)}
            />
          </div>
        </TabsContent>
      </Tabs>
    </>
  )
}

function ProposalsTable({
  proposals,
  workspaceId,
}: {
  proposals: OperationsAgentDetail["proposals"]
  workspaceId: string
}) {
  const rows: Proposal[] = proposals.map((p) => ({
    ...p,
    label: `Versión ${p.versionNumber} · Revisión ${p.number}`,
    statusLabel: submissionLabels[p.status] ?? "Estado desconocido",
  }))
  const columns: ColumnDef<Proposal>[] = [
    {
      id: "proposal",
      accessorFn: (p) => p.number,
      header: header("Propuesta"),
      cell: ({ row }) => (
        <span className="font-medium whitespace-nowrap">
          {row.original.label}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: header("Estado"),
      cell: ({ row }) => (
        <Badge
          variant={submissionBadgeVariants[row.original.status] ?? "slate"}
        >
          {row.original.statusLabel}
        </Badge>
      ),
    },
    {
      id: "approval",
      accessorFn: (p) => at(p.approvalExpiresAt),
      header: header("Aprobación"),
      cell: ({ row }) => {
        const p = row.original
        if (p.approvalReason === null)
          return <span className="text-muted-foreground">Sin aprobación</span>
        const valid = p.approvalReason === "valid"
        return (
          <div className="space-y-0.5">
            <StatusIndicator
              state={statusDescriptor("approval", valid ? "valid" : "invalid")}
            />
            <p className="text-xs text-muted-foreground">
              {valid && p.approvalExpiresAt
                ? `Plazo para activar: ${utc(p.approvalExpiresAt)}`
                : (approvalLabels[
                    p.approvalReason as keyof typeof approvalLabels
                  ] ?? "Sin aprobación")}
            </p>
          </div>
        )
      },
    },
    {
      id: "submittedAt",
      accessorFn: (p) => at(p.submittedAt),
      header: header("Enviada"),
      cell: ({ row }) => <When value={row.original.submittedAt} />,
    },
    {
      id: "review",
      header: "Revisión",
      enableSorting: false,
      // The receipt exists once a proposal was approved; an open review is
      // opened from Revisiones, which records the access.
      cell: ({ row }) => {
        const p = row.original
        if (p.approvalReason !== null)
          return (
            <Link
              href={`/submissions/${p.id}/receipt?workspace=${workspaceId}`}
              className={linkClass}
            >
              Ver comprobante
            </Link>
          )
        if (["submitted", "in_review"].includes(p.status))
          return (
            <Link
              href={`/submissions?workspace=${workspaceId}`}
              className={linkClass}
            >
              Abrir en Revisiones
            </Link>
          )
        return <span className="text-muted-foreground">Revisión cerrada</span>
      },
    },
  ]
  return (
    <DataTable
      data={rows}
      columns={columns}
      searchKeys={["label", "statusLabel"]}
      searchLabel="Buscar propuestas por versión o estado"
      emptyDescription="Este agente todavía no ha enviado propuestas."
      getRowId={(row) => row.id}
    />
  )
}

function DeploymentsTable({
  deployments,
}: {
  deployments: OperationsAgentDetail["deployments"]
}) {
  const rows: Deployment[] = deployments.map((d) => ({
    ...d,
    environmentLabel: environmentLabels[d.environment],
    statusLabel: deploymentLabels[d.status] ?? "Estado desconocido",
  }))
  const columns: ColumnDef<Deployment>[] = [
    {
      accessorKey: "environmentLabel",
      header: header("Entorno"),
    },
    {
      accessorKey: "status",
      header: header("Estado"),
      cell: ({ row }) => (
        <Badge
          variant={deploymentBadgeVariants[row.original.status] ?? "slate"}
        >
          {row.original.statusLabel}
        </Badge>
      ),
    },
    restingColumn<Deployment>(deploymentResting),
    {
      accessorKey: "versionNumber",
      header: header("Versión"),
      cell: ({ row }) => (
        <span className="tabular-nums">
          Versión {row.original.versionNumber}
        </span>
      ),
    },
    {
      id: "authorizedUntil",
      accessorFn: (d) => at(d.authorizedUntil),
      header: header("Autorizado hasta"),
      cell: ({ row }) => <When value={row.original.authorizedUntil} />,
    },
    {
      id: "spend",
      accessorFn: (d) => d.spentUsd,
      header: header("Gasto"),
      cell: ({ row }) => (
        <span className="tabular-nums">
          {formatMoney(row.original.spentUsd)} de{" "}
          {formatMoney(row.original.budgetUsd)}
        </span>
      ),
    },
    {
      id: "createdAt",
      accessorFn: (d) => at(d.createdAt),
      header: header("Creado"),
      cell: ({ row }) => <When value={row.original.createdAt} />,
    },
    {
      id: "activatedAt",
      accessorFn: (d) => at(d.activatedAt),
      header: header("Activado"),
      cell: ({ row }) => <When value={row.original.activatedAt} />,
    },
  ]
  return (
    <DataTable
      data={rows}
      columns={columns}
      searchKeys={["environmentLabel", "statusLabel"]}
      searchLabel="Buscar despliegues por entorno o estado"
      emptyDescription="Este agente todavía no tiene despliegues."
      getRowId={(row) => row.id}
    />
  )
}
