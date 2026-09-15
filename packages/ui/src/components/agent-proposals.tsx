"use client"
import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import {
  Trash2Icon,
  ClipboardCheckIcon,
  EllipsisIcon,
  BanIcon,
  SparklesIcon,
} from "lucide-react"
import {
  submissionLabels,
  type AgentView,
  type FormResult,
} from "@agentonic/contracts/authoring"
import {
  criterionReviewed,
  reviewFlowLabels,
  type ReviewFlowState,
} from "@agentonic/contracts/review-flow"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { ReviewCriteriaDialog } from "@workspace/ui/components/review-criteria-dialog"
import {
  Preparation,
  PreparationForm,
} from "@workspace/ui/components/review-flow-panel"
import { ProposalReceipt } from "@workspace/ui/components/proposal-receipt"
import {
  Dialog,
  DialogContent,
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
import { SubmissionStatusBadge } from "@workspace/ui/components/status-badge"
import { Badge } from "@workspace/ui/components/badge"
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
  candidates: AgentView["candidates"]
  submissions: AgentView["submissions"]
  state: ReviewFlowState
  action: (input: unknown) => Promise<FormResult>
  withdraw: (id: string) => Promise<FormResult>
}
function ProposalActions({
  submission,
  agentName,
  candidates,
  state,
  action,
  withdraw,
}: Omit<ProposalProps, "submissions"> & {
  submission: AgentView["submissions"][number]
}) {
  const router = useRouter()
  const [view, setView] = useState<"review" | "cancel" | "withdraw" | null>(
    null
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const records = state.preparations.filter(
    (p) => p.submissionId === submission.id
  )
  const record = records[0]
  const versionNumber = candidates.find(
    (candidate) => candidate.id === submission.candidateId
  )?.number
  const canWithdraw = ["submitted", "in_review"].includes(submission.status)
  const canPrepare = state.canPrepare && canWithdraw
  async function run() {
    if (pending) return
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
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Acciones de la propuesta ${submission.number}`}
            />
          }
        >
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onClick={() => setView("review")}>
            <ClipboardCheckIcon />
            Revisar versión
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
            disabled={!canWithdraw}
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
      {view === "review" &&
      record?.status === "criteria_ready" &&
      record.canEdit &&
      record.criteria.length > 0 ? (
        <ReviewCriteriaDialog
          record={record}
          action={action}
          initialOpen
          onClose={() => setView(null)}
        />
      ) : (
        <Dialog
          open={view === "review"}
          onOpenChange={(open) => {
            if (!open) setView(null)
          }}
        >
          <DialogContent className="max-w-4xl gap-6">
            <div className="space-y-2">
              <DialogTitle>
                Revisión de la propuesta {submission.number}
              </DialogTitle>
              <DialogDescription>
                Consulta el estado, los criterios y los resultados de esta
                versión.
              </DialogDescription>
            </div>
            <ProposalReceipt
              submission={submission}
              record={record}
              agentName={agentName}
              versionNumber={versionNumber}
            />
            {canPrepare && (
              <AgentSettingsCard
                title="Preparar la evaluación"
                icon={<SparklesIcon />}
                description="Autoriza la preparación de situaciones con IA para esta versión. Podrás revisarlas antes de ejecutar las pruebas."
              >
                <PreparationForm submissionId={submission.id} action={action} />
              </AgentSettingsCard>
            )}
            {!record && !canPrepare && canWithdraw && (
              <p className="text-sm text-muted-foreground">
                La preparación estará disponible cuando el servicio de
                evaluación esté habilitado para esta versión.
              </p>
            )}
            {records.length > 1 && (
              <details>
                <summary className="cursor-pointer text-sm font-medium">
                  Revisiones anteriores
                </summary>
                <div className="mt-4 space-y-6">
                  {records.slice(1).map((p) => (
                    <Preparation key={p.id} record={p} showCancel={false} />
                  ))}
                </div>
              </details>
            )}
          </DialogContent>
        </Dialog>
      )}
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
                : `Retirar propuesta ${submission.number}`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {view === "cancel"
                ? "Se detendrá la evaluación autorizada y dejarán de estar disponibles sus criterios y resultados. El consumo realizado se conserva."
                : "Se detendrá la revisión y se revocará el acceso del equipo. La versión y el historial se conservan; para reenviar, prepara otra versión."}
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
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => void run()}
            >
              {pending ? "Procesando…" : "Confirmar"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
export function AgentProposals({
  agentName,
  candidates,
  submissions,
  state,
  action,
  withdraw,
}: ProposalProps) {
  const router = useRouter()
  const active = state.preparations.some((p) =>
    ["queued", "preparing", "evaluating"].includes(p.status)
  )
  useEffect(() => {
    const timer = setInterval(() => router.refresh(), active ? 4000 : 15000)
    return () => clearInterval(timer)
  }, [active, router])
  return (
    <AgentSettingsCard
      title="Propuestas"
      description="Consulta tus envíos y revisa las situaciones antes de autorizar la evaluación."
    >
      {!submissions.length ? (
        <p className="text-sm text-muted-foreground">
          Aún no has enviado propuestas.
        </p>
      ) : (
        <Table
          aria-label="Propuestas"
          className="min-w-[700px] table-fixed"
          containerClassName="border-t"
        >
          <TableHeader>
            <TableRow>
              <TableHead className="w-12">
                <span className="sr-only">Acciones</span>
              </TableHead>
              <TableHead>Propuesta</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead className="whitespace-normal">
                Revisión de la versión
              </TableHead>
              <TableHead>Comentarios</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {submissions.map((s) => {
              const record = state.preparations.find(
                (p) => p.submissionId === s.id
              )
              const count =
                record?.criteria.filter(criterionReviewed).length ?? 0
              return (
                <TableRow key={s.id}>
                  <TableCell className="py-3 align-top">
                    <ProposalActions
                      submission={s}
                      agentName={agentName}
                      candidates={candidates}
                      state={state}
                      action={action}
                      withdraw={withdraw}
                    />
                  </TableCell>
                  <TableCell className="py-4 align-top font-medium">
                    Propuesta {s.number}
                  </TableCell>
                  <TableCell className="py-4 align-top">
                    <SubmissionStatusBadge status={s.status} />
                  </TableCell>
                  <TableCell className="py-4 align-top whitespace-normal">
                    <div className="space-y-2">
                      <Badge
                        variant={
                          record?.status === "criteria_ready" &&
                          count === record.criteria.length
                            ? "success"
                            : "slate"
                        }
                      >
                        {record
                          ? record.status === "criteria_ready"
                            ? `${count}/${record.criteria.length} revisadas`
                            : reviewFlowLabels[record.status]
                          : "Sin iniciar"}
                      </Badge>
                      {record?.status === "criteria_ready" && (
                        <p className="text-xs text-muted-foreground">
                          {count === record.criteria.length
                            ? "Pendiente de confirmar"
                            : "Revisión del cliente pendiente"}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="space-y-3 py-4 align-top whitespace-normal">
                    <div className="space-y-3 break-words">
                      {s.note && (
                        <p className="whitespace-pre-wrap">{s.note}</p>
                      )}
                      {s.decisions.map((d) => (
                        <div
                          key={d.number}
                          className="space-y-1 border-l-2 pl-3"
                        >
                          <p className="font-medium">
                            {submissionLabels[d.decision] ?? d.decision}
                          </p>
                          {d.feedback && (
                            <p className="whitespace-pre-wrap text-muted-foreground">
                              {d.feedback}
                            </p>
                          )}
                        </div>
                      ))}
                      {!s.note && !s.decisions.length && (
                        <span className="text-muted-foreground">
                          Sin comentarios
                        </span>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      )}
    </AgentSettingsCard>
  )
}
