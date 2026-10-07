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
  Count,
  FieldStack,
  sortableHeader,
  type StackField,
} from "@workspace/ui/components/table-cells"
import { restingColumn } from "@workspace/ui/components/resting-column"

export const facetTitles = {
  live: "Versión en uso",
  next: "Próxima versión",
} as const

/** A facet's facts as labelled fields (UI contract §3, field standard). The
 * version in use's state is not here: it is the row's Despliegue badge. */
export function AgentVersionFacet({
  view,
  facet,
}: {
  view: AgentVersionsView
  facet: "live" | "next"
}) {
  const f = view[facet]
  const fields: StackField[] = [
    ...(f.versionNumber !== null
      ? [{ label: "Versión", value: <Count value={f.versionNumber} /> }]
      : []),
    ...(facet === "next" && f.state
      ? [{ label: "Estado", value: <StatusIndicator state={f.state} /> }]
      : []),
    ...(f.place ? [{ label: "Entorno", value: f.place }] : []),
    ...(f.more.length
      ? [
          {
            label: "Otros entornos",
            value: f.more.map((m) => m.detail).join(" · "),
          },
        ]
      : []),
  ]
  return fields.length ? (
    <FieldStack fields={fields} />
  ) : (
    <Absent>{f.detail}</Absent>
  )
}

/** The version in use's state: the row's one badge, alone in its cell. */
export function AgentDeploymentBadge({ view }: { view: AgentVersionsView }) {
  return view.live.state ? (
    <StatusIndicator appearance="badge" state={view.live.state} />
  ) : (
    <Absent>Sin despliegue</Absent>
  )
}

/** Versión en uso, Despliegue, En reposo and Próxima versión for a table of
 * agents. */
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
    sortKey: (v: AgentVersionsView) => number,
    render: (v: AgentVersionsView) => React.ReactNode
  ): ColumnDef<T> => ({
    id,
    accessorFn: (row: T) => {
      const v = view(row)
      return v ? sortKey(v) : Infinity
    },
    header: sortableHeader<T>(title),
    cell: ({ row }) => {
      const v = view(row.original)
      return v ? render(v) : unavailable
    },
  })
  return [
    column(
      "live",
      facetTitles.live,
      (v) => v.live.versionNumber ?? Infinity,
      (v) => <AgentVersionFacet view={v} facet="live" />
    ),
    column(
      "deployment",
      "Despliegue",
      (v) => v.live.rank,
      (v) => <AgentDeploymentBadge view={v} />
    ),
    restingColumn<T>((row) => view(row)?.resting, unavailable),
    column(
      "next",
      facetTitles.next,
      (v) => v.next.rank,
      (v) => <AgentVersionFacet view={v} facet="next" />
    ),
  ]
}

/** An agent's name, opening its page (blue underlined link, UI contract §3). */
export function AgentLink({ href, name }: { href: string; name: string }) {
  return <CellLink href={href}>{name}</CellLink>
}
