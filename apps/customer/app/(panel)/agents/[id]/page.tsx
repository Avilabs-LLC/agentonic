import Link from "next/link"
import { MessageSquareIcon } from "lucide-react"
import { buttonVariants } from "@workspace/ui/components/button"
import { notFound } from "next/navigation"
import { loadWorkspace, loadAgent } from "@agentonic/server/authoring"
import { submissionLabels } from "@agentonic/contracts/authoring"
import { RecordHeader, BackRow } from "@workspace/ui/components/record-header"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@workspace/ui/components/card"
import { AgentWorkflow } from "@workspace/ui/components/agent-workflow"
import { ConfirmMutation } from "@workspace/ui/components/confirm-mutation"
import { Badge } from "@workspace/ui/components/badge"
import { SubmissionStatusBadge } from "@workspace/ui/components/status-badge"
import { customerWorkspace } from "@/lib/workspace"
import {
  saveDraft,
  freezeCandidate,
  sendSubmission,
  withdrawSubmission,
} from "../actions"
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ workspace?: string }>
}) {
  const { selected } = await customerWorkspace(searchParams)
  const { id } = await params
  const [data, workspace] = await Promise.all([
    loadAgent(selected.id, id),
    loadWorkspace(selected.id),
  ])
  if (!data || !workspace) notFound()
  const codes = workspace.templates.filter(
    (t) => t.id === data.agent.templateVersionId
  )
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <BackRow href={`/agents?workspace=${selected.id}`} />
      <RecordHeader
        title={data.agent.name}
        description={
          data.agent.description ??
          "Personaliza tu agente y prepara una propuesta."
        }
        actions={
          <div className="flex items-center gap-3">
            <Badge variant="slate">Sin despliegue</Badge>
            <Link
              className={buttonVariants({ variant: "outline" })}
              href={`/agents/${id}/preview?workspace=${selected.id}`}
            >
              <MessageSquareIcon aria-hidden="true" />
              Probar versión
            </Link>
          </div>
        }
      />
      <AgentWorkflow
        key={data.draft.revision}
        data={data}
        collections={workspace.collections}
        codes={codes}
        save={saveDraft.bind(null, selected.id, id)}
        freeze={freezeCandidate.bind(null, selected.id, id)}
        submit={sendSubmission.bind(null, selected.id, id)}
      />
      <Card className="gap-5 py-6 [--card-spacing:--spacing(6)]">
        <CardHeader className="gap-2">
          <CardTitle>
            <h2 className="text-xl font-semibold tracking-tight">
              Propuestas y comentarios
            </h2>
          </CardTitle>
          <CardDescription className="text-sm leading-relaxed">
            Consulta el estado de tus envíos y las indicaciones de nuestro
            equipo.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!data.submissions.length && (
            <p className="text-sm text-muted-foreground">
              Aún no has enviado propuestas.
            </p>
          )}
          {data.submissions.map((s) => (
            <div key={s.id} className="space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-medium">Propuesta {s.number}</p>
                <SubmissionStatusBadge status={s.status} />
              </div>
              {s.note && (
                <p className="text-sm whitespace-pre-wrap">{s.note}</p>
              )}
              {s.decisions.map((d) => (
                <div key={d.number} className="border-l-2 pl-3 text-sm">
                  <p className="font-medium">
                    {submissionLabels[d.decision] ?? d.decision}
                  </p>
                  <p className="whitespace-pre-wrap text-muted-foreground">
                    {d.feedback}
                  </p>
                </div>
              ))}
              {["submitted", "in_review"].includes(s.status) && (
                <ConfirmMutation
                  action={withdrawSubmission.bind(null, selected.id, id, s.id)}
                  label="Retirar propuesta"
                  description="Se detendrá la revisión y se revocará el acceso del equipo a esta propuesta. Para reenviar, guarda y congela otra revisión."
                />
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
