"use client"
import { WorkspaceName } from "@workspace/ui/components/workspace-name"
import { AgentLink } from "@workspace/ui/components/agent-versions"
import { statusDescriptor } from "@workspace/ui/lib/badge-status"
import { StatusIndicator } from "@workspace/ui/components/status-badge"
import {
  Absent,
  CellButton,
  Count,
  Deadline,
  sortableHeader,
  timeKey,
} from "@workspace/ui/components/table-cells"
import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import type { ColumnDef } from "@tanstack/react-table"
import type { FormResult, ReviewListing } from "@agentonic/contracts/authoring"
import type { OperationsUser } from "@agentonic/contracts/operations"
import { DataTable } from "@workspace/ui/components/data-table"
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
import { actionsMenuClassName } from "@workspace/ui/lib/menus"
import { notify } from "@workspace/ui/lib/toast"
import {
  ChangeReviewStateDialog,
  reviewStateTargets,
  type ReviewStateTarget,
} from "@workspace/ui/components/change-review-state-dialog"
import { MemberCardDialog } from "@workspace/ui/components/member-card-dialog"

const reviewStates = [
  { value: "submitted", label: "Enviadas" },
  { value: "in_review", label: "En revisión" },
  { value: "changes_requested", label: "Cambios solicitados" },
  { value: "rejected", label: "Rechazadas" },
  { value: "withdrawn", label: "Retiradas" },
  { value: "approved", label: "Aprobadas" },
  { value: "revoked", label: "Revocadas" },
  // Closed when a newer version of the agent was approved (migration 67).
  { value: "superseded", label: "Reemplazadas" },
]
// Tabs that appear only when they have reviews.
const occasionalStates = ["approved", "revoked", "superseded"]

type Review = ReviewListing[number]

export function ReviewTable({
  reviews,
  workspaces,
  selectedWorkspace,
  selectedState = "submitted",
  openReview,
  changeState,
  loadMember,
  revokeApproval,
  now,
}: {
  now: string
  reviews: ReviewListing
  workspaces: { id: string; name: string }[]
  selectedWorkspace: string
  selectedState?: string
  openReview: (workspaceId: string, submissionId: string) => Promise<FormResult>
  changeState: (
    workspaceId: string,
    submissionId: string,
    decision: string,
    feedback: string
  ) => Promise<FormResult>
  loadMember: (userId: string) => Promise<OperationsUser | null>
  /** Only for administrators and operators. */
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
  const [changing, setChanging] = useState<{
    review: Review
    targets: ReviewStateTarget[]
  } | null>(null)
  const [viewing, setViewing] = useState<Review | null>(null)

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
          <DropdownMenuContent align="start" className={actionsMenuClassName}>
            <DropdownMenuItem onClick={() => setViewing(row.original)}>
              <UserRoundIcon />
              Ver usuario
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
            {(() => {
              const change = reviewStateTargets(row.original, !!revokeApproval)
              return (
                <DropdownMenuItem
                  disabled={"reason" in change || pending}
                  title={"reason" in change ? change.reason : undefined}
                  onClick={() =>
                    "targets" in change &&
                    setChanging({
                      review: row.original,
                      targets: change.targets,
                    })
                  }
                >
                  <ArrowRightLeftIcon />
                  Cambiar estado
                </DropdownMenuItem>
              )
            })()}
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
    {
      accessorKey: "agentName",
      header: sortableHeader<Review>("Agente"),
      // The name opens the agent page; the review number opens the review.
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
      header: sortableHeader<Review>("Espacio", "Espacio de trabajo"),
      cell: ({ row }) => <WorkspaceName name={row.original.workspaceName} />,
    },
    {
      accessorKey: "userEmail",
      header: sortableHeader<Review>("Correo", "Correo electrónico"),
      cell: ({ row }) =>
        row.original.userEmail ?? <Absent>No disponible</Absent>,
    },
    {
      accessorKey: "versionNumber",
      header: sortableHeader<Review>("Versión"),
      cell: ({ row }) => <Count value={row.original.versionNumber} />,
    },
    {
      accessorKey: "number",
      header: sortableHeader<Review>("Revisión"),
      cell: ({ row }) =>
        row.original.canOpen || row.original.status === "approved" ? (
          <CellButton
            className="tabular-nums"
            disabled={pending}
            aria-label={`Ver revisión ${row.original.number} de ${row.original.agentName}`}
            onClick={() => open(row.original)}
          >
            {row.original.number}
            {pending && openingId === row.original.id && (
              <span className="sr-only"> · Abriendo…</span>
            )}
          </CellButton>
        ) : (
          <span
            className="tabular-nums"
            title={
              ["submitted", "in_review"].includes(row.original.status)
                ? "Sin autorización vigente para abrirla"
                : "Revisión cerrada"
            }
          >
            {row.original.number}
          </span>
        ),
    },
    {
      id: "approval",
      accessorFn: (row) => row.approvalReason ?? "",
      header: sortableHeader<Review>("Aprobación"),
      cell: ({ row }) =>
        row.original.approvalReason ? (
          <StatusIndicator
            state={statusDescriptor("approval", row.original.approvalReason)}
          />
        ) : (
          <Absent>No disponible</Absent>
        ),
    },
    {
      id: "approvalExpiresAt",
      accessorFn: (row) => timeKey(row.approvalExpiresAt),
      header: sortableHeader<Review>("Activar hasta", "Plazo para activar"),
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
      id: "deployment",
      accessorFn: (row) => row.deploymentStatus ?? "none",
      header: sortableHeader<Review>("Despliegue"),
      cell: ({ row }) =>
        (row.original.deploymentStatus ?? "none") === "none" ? (
          <Absent>Sin despliegue</Absent>
        ) : (
          <StatusIndicator
            appearance="badge"
            state={statusDescriptor(
              "deployment",
              row.original.deploymentStatus!
            )}
          />
        ),
    },
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
            onValueChange={(value) => {
              // Pressing the workspace already chosen reloads nothing.
              if ((value ?? "all") !== selectedWorkspace)
                selectWorkspace(value ?? "all")
            }}
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
      {changing && (
        <ChangeReviewStateDialog
          review={changing.review}
          targets={changing.targets}
          onClose={() => setChanging(null)}
          changeState={changeState}
          revokeApproval={revokeApproval}
        />
      )}
      {viewing && (
        <MemberCardDialog
          userId={viewing.userId}
          name={viewing.userName}
          email={viewing.userEmail}
          loadMember={loadMember}
          onClose={() => setViewing(null)}
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
                  !occasionalStates.includes(state.value) ||
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
                        ![
                          "approval",
                          "approvalExpiresAt",
                          "deployment",
                        ].includes(c.id ?? "")
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
