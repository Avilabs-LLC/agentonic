"use client"
// The version in use and the next version of an agent (architecture §55),
// shared by the Admin and customer agent lists and the Admin agent page.
import Link from "next/link"
import type { Column, ColumnDef } from "@tanstack/react-table"
import type { AgentVersionSummary } from "@agentonic/contracts/agent-versions"
import { customerEnvironmentLabels } from "@agentonic/contracts/availability"
import {
  agentVersionsView,
  type AgentVersionsView,
} from "@workspace/ui/lib/agent-versions"
import { Badge } from "@workspace/ui/components/badge"
import { StatusIndicator } from "@workspace/ui/components/status-badge"
import { DataTableColumnHeader } from "@workspace/ui/components/data-table"

export const facetTitles = {
  live: "Versión en uso",
  next: "Próxima versión",
} as const

export function AgentVersionFacet({
  view,
  facet,
}: {
  view: AgentVersionsView
  facet: "live" | "next"
}) {
  const f = view[facet]
  return (
    <div className="max-w-56 min-w-36 space-y-1 whitespace-normal">
      {f.state &&
        (view.primary === facet ? (
          <Badge variant={f.badge}>{f.state.label}</Badge>
        ) : (
          <StatusIndicator state={f.state} />
        ))}
      <p
        className={
          f.state ? "text-xs text-muted-foreground" : "text-muted-foreground"
        }
      >
        {f.detail}
      </p>
      {f.more.map((m) => (
        <div key={m.detail} className="space-y-0.5 pt-1">
          <StatusIndicator state={m.state} className="text-xs" />
          <p className="text-xs text-muted-foreground">{m.detail}</p>
        </div>
      ))}
    </div>
  )
}

/** "Versión en uso" and "Próxima versión" columns for a table of agents. */
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
  return (["live", "next"] as const).map((facet) => ({
    id: facet,
    accessorFn: (row: T) => view(row)?.[facet].rank ?? Infinity,
    header: function SortableHeader({
      column,
    }: {
      column: Column<T, unknown>
    }) {
      return (
        <DataTableColumnHeader column={column} title={facetTitles[facet]} />
      )
    },
    cell: ({ row }) => {
      const v = view(row.original)
      return v ? <AgentVersionFacet view={v} facet={facet} /> : unavailable
    },
  }))
}

/** An agent's name, opening its page (blue underlined link, UI contract §3). */
export function AgentLink({ href, name }: { href: string; name: string }) {
  return (
    <Link
      href={href}
      className="font-medium text-blue-600 underline underline-offset-4 outline-none hover:text-blue-800 focus-visible:ring-2 focus-visible:ring-ring dark:text-blue-400 dark:hover:text-blue-300"
    >
      {name}
    </Link>
  )
}
