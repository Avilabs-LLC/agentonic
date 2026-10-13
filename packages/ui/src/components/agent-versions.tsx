"use client"
// The version in use and the next version of an agent (architecture §55),
// shared by the Admin and customer agent lists and the Admin agent page.
import type { ColumnDef } from "@tanstack/react-table"
import type { AgentVersionSummary } from "@agentonic/contracts/agent-versions"
import { customerEnvironmentLabels } from "@agentonic/contracts/availability"
import {
  agentVersionsView,
  type AgentVersionsView,
} from "@workspace/ui/lib/agent-versions"
import { StatusIndicator } from "@workspace/ui/components/status-badge"
import {
  Absent,
  CellLink,
  VersionNumber,
  sortableHeader,
} from "@workspace/ui/components/table-cells"
import { restingColumn } from "@workspace/ui/components/resting-column"

export const facetTitles = {
  live: "Versión en uso",
  next: "Próxima versión",
} as const

/** The version in use's state: the row's one badge, alone in its cell. */
export function AgentDeploymentBadge({ view }: { view: AgentVersionsView }) {
  return view.live.state ? (
    <StatusIndicator appearance="badge" state={view.live.state} />
  ) : (
    <Absent>Sin despliegue</Absent>
  )
}

/** The agent version columns for a table of agents, one fact each (UI
 * contract §3.1): En uso, Entorno, Despliegue, En reposo, Próxima and
 * Propuesta (the next version's state, inline). */
export function agentVersionColumns<T>(
  summary: (row: T) => AgentVersionSummary | null,
  unavailable: React.ReactNode = null,
  audience: "staff" | "customer" = "staff"
): ColumnDef<T>[] {
  const view = (row: T) => {
    const s = summary(row)
    return s
      ? agentVersionsView(
          s,
          audience === "customer" ? customerEnvironmentLabels : undefined
        )
      : null
  }
  const column = (
    id: string,
    title: string,
    description: string | undefined,
    sortKey: (v: AgentVersionsView) => number | string,
    render: (v: AgentVersionsView) => React.ReactNode
  ): ColumnDef<T> => ({
    id,
    accessorFn: (row: T) => {
      const v = view(row)
      return v ? sortKey(v) : Infinity
    },
    header: sortableHeader<T>(title, description),
    cell: ({ row }) => {
      const v = view(row.original)
      return v ? render(v) : unavailable
    },
  })
  const version = (n: number | null) =>
    n === null ? <Absent>Ninguna</Absent> : <VersionNumber value={n} />
  return [
    column(
      "live",
      "En uso",
      facetTitles.live,
      (v) => v.live.versionNumber ?? Infinity,
      (v) => version(v.live.versionNumber)
    ),
    column(
      "environment",
      "Entorno",
      "Entorno de la versión en uso",
      (v) => v.live.place ?? "",
      (v) =>
        v.live.place ? (
          <span
            title={v.live.more.map((m) => m.detail).join(" · ") || undefined}
          >
            {v.live.place}
            {v.live.more.length > 0 && ` y ${v.live.more.length} más`}
          </span>
        ) : (
          <Absent>No aplica</Absent>
        )
    ),
    column(
      "deployment",
      "Despliegue",
      undefined,
      (v) => v.live.rank,
      (v) => <AgentDeploymentBadge view={v} />
    ),
    restingColumn<T>((row) => view(row)?.resting, unavailable),
    column(
      "next",
      "Próxima",
      facetTitles.next,
      (v) => v.next.versionNumber ?? Infinity,
      (v) => version(v.next.versionNumber)
    ),
    column(
      "proposal",
      "Propuesta",
      "Estado de la próxima versión",
      (v) => v.next.rank,
      (v) =>
        v.next.state ? (
          <StatusIndicator state={v.next.state} />
        ) : (
          <Absent>No aplica</Absent>
        )
    ),
  ]
}

/** An agent's name, opening its page (blue underlined link, UI contract §3). */
export function AgentLink({ href, name }: { href: string; name: string }) {
  return <CellLink href={href}>{name}</CellLink>
}
