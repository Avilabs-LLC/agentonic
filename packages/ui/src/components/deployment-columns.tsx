"use client"
// The columns every deployment table shares, in one order (UI contract §3):
// Versión, Entorno, Trabajador, Estado, En reposo, Uso autorizado hasta,
// Gasto, Creado, Activado. A table shows Versión or Trabajador only when its
// rows carry them.
import type { ColumnDef } from "@tanstack/react-table"
import { formatMoney } from "@agentonic/contracts/format"
import { environmentLabels } from "@agentonic/contracts/lifecycle"
import { statusDescriptor } from "@workspace/ui/lib/badge-status"
import { StatusIndicator } from "@workspace/ui/components/status-badge"
import {
  deploymentResting,
  restingColumn,
} from "@workspace/ui/components/resting-column"
import {
  Absent,
  Code,
  Count,
  sortableHeader,
  timeKey,
  When,
} from "@workspace/ui/components/table-cells"

type DeploymentRow = {
  environment: keyof typeof environmentLabels
  status: string
  resting: boolean
  authorizedUntil: string
  budgetUsd: number
  spentUsd: number
  createdAt: string
  activatedAt: string | null
}

export function deploymentColumns<T extends DeploymentRow>({
  version,
  worker,
}: {
  version?: (row: T) => number | undefined
  worker?: (row: T) => string | null
} = {}): ColumnDef<T>[] {
  const header = sortableHeader<T>
  return [
    ...(version
      ? [
          {
            id: "version",
            accessorFn: (row: T) => version(row) ?? Infinity,
            header: header("Versión"),
            cell: ({ row }) => {
              const n = version(row.original)
              return n === undefined ? (
                <Absent>No disponible</Absent>
              ) : (
                <Count value={n} />
              )
            },
          } satisfies ColumnDef<T>,
        ]
      : []),
    {
      id: "environment",
      accessorFn: (row) => environmentLabels[row.environment],
      header: header("Entorno"),
    },
    ...(worker
      ? [
          {
            id: "worker",
            accessorFn: (row: T) => worker(row) ?? "",
            header: header("Trabajador"),
            cell: ({ row }) => {
              const name = worker(row.original)
              return name ? (
                <Code>{name}</Code>
              ) : (
                <Absent>Sin trabajador</Absent>
              )
            },
          } satisfies ColumnDef<T>,
        ]
      : []),
    {
      accessorKey: "status",
      header: header("Estado"),
      cell: ({ row }) => (
        <StatusIndicator
          appearance="badge"
          state={statusDescriptor("deployment", row.original.status)}
        />
      ),
    },
    restingColumn<T>(deploymentResting),
    {
      id: "authorizedUntil",
      accessorFn: (row) => timeKey(row.authorizedUntil),
      header: header("Uso hasta", "Uso autorizado hasta"),
      cell: ({ row }) => <When value={row.original.authorizedUntil} />,
    },
    {
      id: "spent",
      accessorFn: (row) => row.spentUsd,
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
      accessorFn: (row) => timeKey(row.createdAt),
      header: header("Creado"),
      cell: ({ row }) => <When value={row.original.createdAt} />,
    },
    {
      id: "activatedAt",
      accessorFn: (row) => timeKey(row.activatedAt),
      header: header("Activado"),
      cell: ({ row }) => (
        <When value={row.original.activatedAt} empty="Sin activar" />
      ),
    },
  ]
}
