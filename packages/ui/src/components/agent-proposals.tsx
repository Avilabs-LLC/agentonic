"use client"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Trash2Icon,
  ClipboardCheckIcon,
  EllipsisIcon,
  BanIcon,
  PlayIcon,
} from "lucide-react"
import {
  type AgentView,
  type FormResult,
} from "@agentonic/contracts/authoring"
import {
  batchRunning,
  type ReviewFlowState,
} from "@agentonic/contracts/review-flow"
import type { LifecycleState } from "@agentonic/contracts/lifecycle"
import {
  proposalDescriptor,
  proposalStatus,
} from "@agentonic/contracts/proposals"
import { preparedVersionLabel } from "@agentonic/contracts/workflow"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import { ReviewCriteriaDialog } from "@workspace/ui/components/review-criteria-dialog"
import { PreparationForm } from "@workspace/ui/components/review-flow-panel"
import { ProposalConfigurationSummary } from "@workspace/ui/components/proposal-configuration-summary"
import { ProposalDialogHeader } from "@workspace/ui/components/proposal-dialog-header"
import {
  ModelResultsDialog,
  RunModelEvaluationDialog,
  modelResultsLabel,
} from "@workspace/ui/components/model-evaluation-dialog"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@workspace/ui/components/dialog"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@workspace/ui/components/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@workspace/ui/components/dropdown-menu"
import { notify } from "@workspace/ui/lib/toast"
import { ProposalStatusBadge } from "@workspace/ui/components/status-badge"
import { Button } from "@workspace/ui/components/button"
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@workspace/ui/components/table"
type ProposalProps = {
  agentName: string
  approvals: LifecycleState["submissions"]
  candidates: AgentView["candidates"]
  submissions: AgentView["submissions"]
  state: ReviewFlowState
  action: (input: unknown) => Promise<FormResult>
  withdraw: (id: string) => Promise<FormResult>
}
function ProposalRow({
  submission,
  agentName,
  approvals,
  candidates,
  state,
  action,
  withdraw,
}: Omit<ProposalProps, "submissions"> & {
  submission: AgentView["submissions"][number]
}) {
  const router = useRouter()
  const [view, setView] = useState<
    | "details"
    | "criteria"
    | "results"
    | "run"
    | "prepare"
    | "cancel"
    | "withdraw"
    | null
  >(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const record = state.preparations.find(
    (p) => p.submissionId === submission.id
  )
  const candidate = candidates.find((c) => c.id === submission.candidateId)
  const version = candidate
    ? preparedVersionLabel(candidate)
    : "Versión no disponible"
  const descriptor = proposalDescriptor(
    record?.versionNumber ?? candidate?.number ?? candidate?.revision,
    record?.revision
  )
  const confirmed = record && record.confirmedRevision === record.revision
  const running = batchRunning(record?.batches[0])
  const approval = approvals.find((item) => item.id === submission.id)
  const status = proposalStatus(submission.status, record, approval)
  const recover =
    state.canPrepare &&
    ["submitted", "in_review"].includes(submission.status) &&
    !running &&
    (!record ||
      (!record.criteria.length &&
        ["error", "cancelled"].includes(record.status)))
  async function revoke() {
    setPending(true)
    setError("")
    try {
      const result =
        view === "cancel" && record
          ? await action({
              operation: "cancel",
              payload: { preparationId: record.id },
            })
          : await withdraw(submission.id)
      if (!result.ok) {
        setError(result.message)
        return
      }
      notify.success(result.message)
      setView(null)
      router.refresh()
    } catch {
      setError("No se pudo completar la acción. Inténtalo de nuevo.")
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      <TableRow>
        <TableCell className="py-3 align-top">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Acciones de ${version.toLowerCase()}`}
                />
              }
            >
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {recover && (
                <DropdownMenuItem onClick={() => setView("prepare")}>
                  <ClipboardCheckIcon />
                  Preparar criterios
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                disabled={!record?.canRun || running}
                onClick={() => setView("run")}
              >
                <PlayIcon />
                {running ? "Evaluación en curso" : "Evaluar modelos"}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!record?.canCancel}
                onClick={() => {
                  setError("")
                  setView("cancel")
                }}
              >
                <BanIcon />
                Cancelar autorización
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                disabled={
                  !["submitted", "in_review"].includes(submission.status)
                }
                onClick={() => {
                  setError("")
                  setView("withdraw")
                }}
              >
                <Trash2Icon />
                Retirar propuesta
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </TableCell>
        <TableCell className="py-4 align-top font-medium">
          <Button
            variant="link"
            size="sm"
            className="h-auto p-0 underline"
            aria-label={`Ver detalle de ${descriptor.toLowerCase()}`}
            onClick={() => setView("details")}
          >
            {descriptor}
          </Button>
        </TableCell>
        <TableCell className="py-4 align-top">
          <ProposalStatusBadge status={status} />
        </TableCell>
        <TableCell className="py-3 align-top whitespace-normal">
          {record?.criteria.length ? (
            <Button
              variant={!confirmed && record.canEdit ? "default" : "link"}
              size="sm"
              className="h-auto whitespace-normal"
              aria-label={`${!confirmed && record.canEdit ? "Confirmar" : "Ver"} criterios de ${version.toLowerCase()}`}
              onClick={() => setView("criteria")}
            >
              {!confirmed && record.canEdit ? "Confirmar" : "Ver"}
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">
              {status === "in_progress" &&
              record &&
              ["queued", "preparing"].includes(record.status)
                ? "Preparando…"
                : "—"}
            </span>
          )}
        </TableCell>
        <TableCell className="py-3 align-top">
          {record?.batches.length ? (
            <Button
              variant="link"
              className="h-auto whitespace-nowrap"
              onClick={() => setView("results")}
            >
              {running ? "Ver progreso" : modelResultsLabel(record)}
            </Button>
          ) : record?.canRun && !running ? (
            <Button
              variant="link"
              className="h-auto whitespace-nowrap"
              aria-label={`Evaluar modelos de ${version.toLowerCase()}`}
              onClick={() => setView("run")}
            >
              Evaluar
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">—</span>
          )}
        </TableCell>
      </TableRow>
      <Dialog
        open={view === "details"}
        onOpenChange={(open) => {
          if (!open) setView(null)
        }}
      >
        <DialogContent className="max-w-2xl">
          <ProposalDialogHeader
            section="Propuesta"
            agentName={agentName}
            version={
              record?.versionNumber ?? candidate?.number ?? candidate?.revision
            }
            revision={record?.revision}
          />
          <ProposalConfigurationSummary snapshot={candidate?.snapshot} />
        </DialogContent>
      </Dialog>
      {record && view === "criteria" && (
        <ReviewCriteriaDialog
          record={record}
          action={action}
          initialOpen
          onClose={() => setView(null)}
        />
      )}
      {record && view === "results" && (
        <ModelResultsDialog
          record={record}
          open
          onClose={() => setView(null)}
        />
      )}
      {record && view === "run" && (
        <RunModelEvaluationDialog
          record={record}
          action={action}
          onClose={() => setView(null)}
          onStarted={() => setView("results")}
        />
      )}
      <Dialog
        open={view === "prepare"}
        onOpenChange={(open) => {
          if (!open) setView(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Preparar criterios · {version}</DialogTitle>
            <DialogDescription>
              Prepararemos situaciones con IA para que las revises y confirmes.
            </DialogDescription>
          </DialogHeader>
          <PreparationForm
            submissionId={submission.id}
            action={async (input) => {
              const result = await action(input)
              if (result.ok) setView(null)
              return result
            }}
          />
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={view === "cancel" || view === "withdraw"}
        onOpenChange={(open) => {
          if (!open && !pending) setView(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {view === "cancel"
                ? "Cancelar autorización"
                : `Retirar ${version.toLowerCase()} de revisión`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {view === "cancel"
                ? "Se detendrán las evaluaciones y dejarán de estar disponibles sus criterios y resultados. El consumo realizado se conserva."
                : "Se detendrá la revisión y se revocará el acceso del equipo. La versión y el historial se conservan."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>Volver</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void revoke()}
            >
              {pending ? "Procesando…" : "Confirmar"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
export function AgentProposals(props: ProposalProps) {
  const router = useRouter()
  const active = props.state.preparations.some(
    (p) =>
      ["queued", "preparing"].includes(p.status) || batchRunning(p.batches[0])
  )
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), active ? 3000 : 15000)
    return () => clearInterval(timer)
  }, [active, router])
  return (
    <AgentSettingsCard
      title="Propuestas"
      icon={<ClipboardCheckIcon />}
      description="Confirma los criterios y compara el desempeño de los modelos para cada versión."
    >
      {!props.submissions.length ? (
        <CardEmptyState title="Sin propuestas">
          Envía una versión desde Configuración para iniciar su revisión.
        </CardEmptyState>
      ) : (
        <Table aria-label="Propuestas">
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <span className="sr-only">Acciones</span>
              </TableHead>
              <TableHead>Propuesta</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Criterios</TableHead>
              <TableHead>Resultados</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.submissions.map((s) => (
              <ProposalRow key={s.id} submission={s} {...props} />
            ))}
          </TableBody>
        </Table>
      )}
    </AgentSettingsCard>
  )
}
