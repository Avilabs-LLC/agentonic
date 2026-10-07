"use client"
import { WorkspaceName } from "@workspace/ui/components/workspace-name"
import { AgentLink } from "@workspace/ui/components/agent-versions"
import { approvalBadgeVariants } from "@workspace/ui/lib/badge-status"
import { Badge } from "@workspace/ui/components/badge"

import {
  approvalLabels,
  deploymentLabels,
} from "@agentonic/contracts/lifecycle"
import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { ColumnDef } from "@tanstack/react-table"
import type { FormResult, ReviewListing } from "@agentonic/contracts/authoring"
import {
  DataTable,
  DataTableColumnHeader,
} from "@workspace/ui/components/data-table"
import { Button } from "@workspace/ui/components/button"
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@workspace/ui/components/tabs"
import {
  EllipsisIcon,
  EyeIcon,
  UserRoundIcon,
  ArrowRightLeftIcon,
} from "lucide-react"
import { FiltersCard } from "@workspace/ui/components/filters-card"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@workspace/ui/components/dropdown-menu"
import { notify } from "@workspace/ui/lib/toast"
import { RevokeApprovalDialog } from "@workspace/ui/components/revoke-approval-dialog"

const reviewStates = [
  { value: "submitted", label: "Enviadas" },
  { value: "in_review", label: "En revisión" },
  { value: "changes_requested", label: "Cambios solicitados" },
  { value: "rejected", label: "Rechazadas" },
  { value: "withdrawn", label: "Retiradas" },
  { value: "approved", label: "Aprobadas" },
  { value: "revoked", label: "Revocadas" },
]

type Review = ReviewListing[number]

export function ReviewTable({
  reviews,
  workspaces,
  selectedWorkspace,
  selectedState = "submitted",
  openReview,
  revokeApproval,
}: {
  reviews: ReviewListing
  workspaces: { id: string; name: string }[]
  selectedWorkspace: string
  selectedState?: string
  openReview: (workspaceId: string, submissionId: string) => Promise<FormResult>
  revokeApproval?: (
    workspaceId: string,
    submissionId: string,
    feedback: string
  ) => Promise<FormResult>
}) {
  const router = useRouter()
  const filterId = useId()
  const [tableReset, setTableReset] = useState(0)
  const workspaceOptions = [
    { value: "all", label: "Todos los espacios" },
    ...workspaces.map((workspace) => ({
      value: workspace.id,
      label: workspace.name,
    })),
  ]
  const [pending, startTransition] = useTransition()
  const [openingId, setOpeningId] = useState<string | null>(null)
  const [error, setError] = useState("")
  const [revoking, setRevoking] = useState<Review | null>(null)

  function selectWorkspace(value: string) {
    setError("")
    startTransition(() => {
      router.push(
        value === "all"
          ? "/submissions"
          : `/submissions?workspace=${encodeURIComponent(value)}`,
        { scroll: false }
      )
    })
  }

  function open(review: Review) {
    if (pending) return
    if (review.status === "approved") {
      router.push(
        `/submissions/${review.id}/receipt?workspace=${review.workspaceId}`
      )
      return
    }
    if (!review.canOpen) return
    setOpeningId(review.id)
    setError("")
    startTransition(async () => {
      try {
        const result = await openReview(review.workspaceId, review.id)
        if (!result.ok || !result.href) {
          setError(result.message)
          notify.destructive(result.message)
          return
        }
        notify.success(result.message)
        router.push(result.href)
      } catch {
        const message = "No se pudo abrir la revisión. Inténtalo de nuevo."
        setError(message)
        notify.destructive(message)
      } finally {
        setOpeningId(null)
      }
    })
  }

  const columns: ColumnDef<Review>[] = [
    {
      id: "actions",
      header: () => <span className="sr-only">Acciones</span>,
      enableSorting: false,
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                disabled={pending}
                aria-label={`Acciones de ${row.original.agentName}, revisión ${row.original.number}`}
              />
            }
          >
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuItem disabled>
              <UserRoundIcon />
              Ver usuario
              <span className="ml-auto text-xs text-muted-foreground">
                Pronto
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={
                (!row.original.canOpen && row.original.status !== "approved") ||
                pending
              }
              onClick={() => open(row.original)}
            >
              <EyeIcon />
              Ver revisión
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {row.original.status === "approved" && revokeApproval && (
              <DropdownMenuItem onClick={() => setRevoking(row.original)}>
                <ArrowRightLeftIcon />
                Revocar aprobación
              </DropdownMenuItem>
            )}
            <DropdownMenuItem disabled>
              <ArrowRightLeftIcon />
              Cambiar estado
              <span className="ml-auto text-xs text-muted-foreground">
                Pronto
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
    {
      accessorKey: "agentName",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Agente" />
      ),
      // The name opens the agent page; the review number opens the review.
      cell: ({ row }) =>
        row.original.agentId ? (
          <AgentLink
            href={`/agents/${row.original.agentId}`}
            name={row.original.agentName}
          />
        ) : (
          <span className="text-xs font-medium">{row.original.agentName}</span>
        ),
    },
    {
      accessorKey: "workspaceName",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Espacio de trabajo" />
      ),
      cell: ({ row }) => <WorkspaceName name={row.original.workspaceName} />,
    },
    {
      accessorKey: "userEmail",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Correo electrónico" />
      ),
      cell: ({ row }) => (
        <span>{row.original.userEmail ?? "No disponible"}</span>
      ),
    },
    {
      accessorKey: "number",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Revisión #" />
      ),
      cell: ({ row }) =>
        row.original.canOpen || row.original.status === "approved" ? (
          <Button
            variant="link"
            className="h-auto p-0 text-xs font-medium text-blue-600 tabular-nums underline underline-offset-4 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
            disabled={pending}
            aria-label={`Ver revisión ${row.original.number} de ${row.original.agentName}`}
            onClick={() => open(row.original)}
          >
            {row.original.number}
            {pending && openingId === row.original.id && (
              <span className="sr-only"> · Abriendo…</span>
            )}
          </Button>
        ) : (
          <div>
            <span className="tabular-nums">{row.original.number}</span>
            <p className="text-xs text-muted-foreground">
              {["submitted", "in_review"].includes(row.original.status)
                ? "Sin autorización vigente"
                : "Revisión cerrada"}
            </p>
          </div>
        ),
    },
    {
      accessorKey: "versionNumber",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Versión #" />
      ),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.versionNumber}</span>
      ),
    },
    ...[
      {
        id: "approvalValidity",
        header: "Autorización",
        cell: ({ row }: { row: { original: Review } }) => (
          <Badge
            variant={
              approvalBadgeVariants[
                row.original
                  .approvalReason as keyof typeof approvalBadgeVariants
              ] ?? "slate"
            }
          >
            {approvalLabels[
              row.original.approvalReason as keyof typeof approvalLabels
            ] ?? "No disponible"}
          </Badge>
        ),
      },
      {
        id: "deployment",
        header: "Despliegue",
        cell: ({ row }: { row: { original: Review } }) => (
          <span>
            {deploymentLabels[row.original.deploymentStatus ?? "none"] ??
              "No disponible"}
          </span>
        ),
      },
    ],
  ]

  return (
    <div className="space-y-4" aria-busy={pending}>
      <FiltersCard
        description="Filtra las revisiones por espacio de trabajo."
        disabled={pending}
        onClear={() => {
          setTableReset((value) => value + 1)
          selectWorkspace("all")
        }}
      >
        <Field>
          <FieldLabel htmlFor={filterId}>Espacio de trabajo</FieldLabel>
          <Select
            items={workspaceOptions}
            value={selectedWorkspace}
            disabled={pending}
            onValueChange={(value) => selectWorkspace(value ?? "all")}
          >
            <SelectTrigger id={filterId} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {workspaceOptions.map((workspace) => (
                <SelectItem key={workspace.value} value={workspace.value}>
                  {workspace.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FiltersCard>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {revoking && revokeApproval && (
        <RevokeApprovalDialog
          name={revoking.agentName}
          onClose={() => setRevoking(null)}
          action={(feedback) =>
            revokeApproval(revoking.workspaceId, revoking.id, feedback)
          }
        />
      )}
      <Tabs
        defaultValue={
          reviewStates.some((s) => s.value === selectedState)
            ? selectedState
            : "submitted"
        }
        className="gap-4"
      >
        <div className="overflow-x-auto">
          <TabsList aria-label="Estado de las revisiones" variant="line">
            {reviewStates
              .filter(
                (state) =>
                  !["approved", "revoked"].includes(state.value) ||
                  reviews.some((review) => review.status === state.value)
              )
              .map((state) => (
                <TabsTrigger key={state.value} value={state.value}>
                  {state.label}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {
                      reviews.filter((review) => review.status === state.value)
                        .length
                    }
                  </span>
                </TabsTrigger>
              ))}
          </TabsList>
        </div>
        {reviewStates.map((state) => (
          <TabsContent key={state.value} value={state.value}>
            <DataTable
              key={`${selectedWorkspace}-${tableReset}`}
              columns={
                state.value === "approved"
                  ? columns
                  : columns.filter(
                      (c) =>
                        c.id !== "approvalValidity" && c.id !== "deployment"
                    )
              }
              data={reviews.filter((review) => review.status === state.value)}
              searchKeys={[
                "userEmail",
                "agentName",
                "workspaceName",
                "number",
                "versionNumber",
              ]}
              searchLabel="Buscar revisiones"
              emptyDescription={`No hay revisiones en «${state.label}».`}
              getRowId={(review) => review.id}
            />
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}
