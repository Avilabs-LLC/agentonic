"use client"
// The Admin agent page (architecture §55): what is in use and what comes next,
// then the agent's proposals, deployments and activity. Metadata only; a
// proposal's content stays behind its review and receipt.
import type { ColumnDef } from "@tanstack/react-table"
import {
  formatCount,
  formatMoney,
  formatUtcParts,
} from "@agentonic/contracts/format"
import { submissionLabels } from "@agentonic/contracts/authoring"
import {
  deploymentLabels,
  environmentLabels,
} from "@agentonic/contracts/lifecycle"
import type { OperationsAgentDetail } from "@agentonic/contracts/operations"
import { agentVersionsView } from "@workspace/ui/lib/agent-versions"
import { statusDescriptor } from "@workspace/ui/lib/badge-status"
import { deploymentColumns } from "@workspace/ui/components/deployment-columns"
import {
  Absent,
  CellLink,
  Count,
  Deadline,
  sortableHeader,
  timeKey,
  When,
} from "@workspace/ui/components/table-cells"
import { cn } from "@workspace/ui/lib/utils"
import {
  iconTones,
  StatusIndicator,
} from "@workspace/ui/components/status-badge"
import { facetTitles } from "@workspace/ui/components/agent-versions"
import { capabilities } from "@workspace/ui/components/operations"
import { DataTable } from "@workspace/ui/components/data-table"
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
  TabsBar,
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
const header = sortableHeader
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
  now,
}: {
  agent: OperationsAgentDetail
  now: string
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
        <TabsBar aria-label="Secciones del agente">
          <TabsTrigger value="propuestas" className="flex-none px-4">
            <TabLabel title="Propuestas" count={agent.proposals.length} />
          </TabsTrigger>
          <TabsTrigger value="despliegues" className="flex-none px-4">
            <TabLabel title="Despliegues" count={agent.deployments.length} />
          </TabsTrigger>
          <TabsTrigger value="actividad" className="flex-none px-4">
            <TabLabel title="Actividad" />
          </TabsTrigger>
        </TabsBar>
        <TabsContent value="propuestas">
          <ProposalsTable
            proposals={agent.proposals}
            workspaceId={agent.workspaceId}
            now={now}
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
  now,
}: {
  proposals: OperationsAgentDetail["proposals"]
  workspaceId: string
  now: string
}) {
  const rows: Proposal[] = proposals.map((p) => ({
    ...p,
    label: `Versión ${p.versionNumber} · Revisión ${p.number}`,
    statusLabel: submissionLabels[p.status] ?? "Estado desconocido",
  }))
  const columns: ColumnDef<Proposal>[] = [
    {
      accessorKey: "versionNumber",
      header: header("Versión"),
      cell: ({ row }) => <Count value={row.original.versionNumber} />,
    },
    {
      accessorKey: "number",
      header: header("Revisión"),
      // As in Revisiones, the review number opens the review: its receipt
      // once approved, otherwise Revisiones, which records the access.
      cell: ({ row }) => {
        const p = row.original
        if (p.approvalReason !== null)
          return (
            <CellLink
              href={`/submissions/${p.id}/receipt?workspace=${workspaceId}`}
              className="tabular-nums"
            >
              <span className="sr-only">Ver comprobante de la revisión </span>
              {p.number}
            </CellLink>
          )
        if (["submitted", "in_review"].includes(p.status))
          return (
            <CellLink
              href={`/submissions?workspace=${workspaceId}`}
              className="tabular-nums"
            >
              <span className="sr-only">Abrir en Revisiones la revisión </span>
              {p.number}
            </CellLink>
          )
        return <Count value={p.number} />
      },
    },
    {
      accessorKey: "status",
      header: header("Estado"),
      cell: ({ row }) => (
        <StatusIndicator
          appearance="badge"
          state={statusDescriptor("submission", row.original.status)}
        />
      ),
    },
    {
      id: "approval",
      accessorFn: (p) => p.approvalReason ?? "",
      header: header("Aprobación"),
      cell: ({ row }) =>
        row.original.approvalReason === null ? (
          <Absent>Sin aprobación</Absent>
        ) : (
          <StatusIndicator
            state={statusDescriptor("approval", row.original.approvalReason)}
          />
        ),
    },
    {
      id: "approvalExpiresAt",
      accessorFn: (p) => timeKey(p.approvalExpiresAt),
      header: header("Activar hasta", "Plazo para activar"),
      cell: ({ row }) => (
        <Deadline
          value={
            row.original.approvalReason === "valid"
              ? row.original.approvalExpiresAt
              : null
          }
          now={now}
        />
      ),
    },
    {
      id: "submittedAt",
      accessorFn: (p) => timeKey(p.submittedAt),
      header: header("Enviada"),
      cell: ({ row }) => <When value={row.original.submittedAt} />,
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
  const columns = deploymentColumns<Deployment>({
    version: (row) => row.versionNumber,
  })
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
