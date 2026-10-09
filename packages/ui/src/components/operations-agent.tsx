"use client"
// The Admin agent page (architecture §55): what is in use and what comes next,
// then the agent's proposals, deployments and activity. Metadata only; a
// proposal's content stays behind its review and receipt.
import type { ReactNode } from "react"
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
import type { FormResult } from "@agentonic/contracts/authoring"
import { agentVersionsView } from "@workspace/ui/lib/agent-versions"
import { statusDescriptor } from "@workspace/ui/lib/badge-status"
import { deploymentColumns } from "@workspace/ui/components/deployment-columns"
import {
  Absent,
  CellButton,
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
import { GmailIcon } from "@workspace/ui/components/gmail-icon"
import { DriveIcon } from "@workspace/ui/components/drive-icon"
import { WebIcon } from "@workspace/ui/components/web-icon"
import { DataTable } from "@workspace/ui/components/data-table"
import { useOpenReview } from "@workspace/ui/hooks/use-open-review"
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
  value: ReactNode
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
          title={typeof value === "string" ? value : undefined}
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
// The latest version's tools as their coloured marks, each named for screen
// readers and on hover; knowledge is counted in the tile's detail.
function Capabilities({ tools }: { tools: OperationsAgentDetail["tools"] }) {
  const marks = [
    ...(tools.gmail ? [{ name: "Gmail", Icon: GmailIcon }] : []),
    ...(tools.drive ? [{ name: "Google Drive", Icon: DriveIcon }] : []),
    ...(tools.web ? [{ name: "Acceso web", Icon: WebIcon }] : []),
  ]
  if (marks.length === 0) return "Sin herramientas"
  return (
    <span className="flex items-center gap-2.5">
      {marks.map(({ name, Icon }) => (
        <span key={name} title={name} className="inline-flex">
          <Icon className="size-6" />
          <span className="sr-only">{name}</span>
        </span>
      ))}
    </span>
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

type OpenReview = (
  workspaceId: string,
  submissionId: string
) => Promise<FormResult>

export function OperationsAgentOverview({
  agent,
  now,
  openReview,
  openable,
}: {
  agent: OperationsAgentDetail
  now: string
  /** Records the review access and returns the review page (Revisiones' action). */
  openReview: OpenReview
  /** Open reviews this staff member may open now: Revisiones' canOpen. */
  openable: string[]
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
          value={<Capabilities tools={agent.tools} />}
          detail={
            agent.latestVersion
              ? [
                  `Versión ${agent.latestVersion}`,
                  ...(agent.tools.collections
                    ? [
                        `${formatCount(agent.tools.collections)} ${agent.tools.collections === 1 ? "colección" : "colecciones"}`,
                      ]
                    : []),
                ].join(" · ")
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
            agentName={agent.name}
            now={now}
            openReview={openReview}
            openable={openable}
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
  agentName,
  now,
  openReview,
  openable,
}: {
  proposals: OperationsAgentDetail["proposals"]
  workspaceId: string
  agentName: string
  now: string
  openReview: OpenReview
  openable: string[]
}) {
  const { open, pending, openingId, error } = useOpenReview(openReview)
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
      // once approved, otherwise the review itself, recording the access.
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
        if (!["submitted", "in_review"].includes(p.status))
          return <Count value={p.number} />
        if (!openable.includes(p.id))
          return (
            <span
              className="tabular-nums"
              title="Sin autorización vigente para abrirla"
            >
              {p.number}
            </span>
          )
        return (
          <CellButton
            className="tabular-nums"
            disabled={pending}
            aria-label={`Ver revisión ${p.number} de ${agentName}`}
            onClick={() => open(workspaceId, p.id)}
          >
            {p.number}
            {pending && openingId === p.id && (
              <span className="sr-only"> · Abriendo…</span>
            )}
          </CellButton>
        )
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
    <div className="space-y-4">
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <DataTable
        data={rows}
        columns={columns}
        searchKeys={["label", "statusLabel"]}
        searchLabel="Buscar propuestas por versión o estado"
        emptyDescription="Este agente todavía no ha enviado propuestas."
        getRowId={(row) => row.id}
      />
    </div>
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
