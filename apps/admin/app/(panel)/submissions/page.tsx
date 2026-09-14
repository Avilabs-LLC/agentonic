import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { reviewWorkspaces, loadReviewQueue } from "@agentonic/server/authoring"
import { PageHeader } from "@workspace/ui/components/page-header"
import { WorkspacePicker } from "@workspace/ui/components/workspace-picker"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@workspace/ui/components/card"
import { MutationForm } from "@workspace/ui/components/mutation-form"
import { Badge } from "@workspace/ui/components/badge"
import { submissionLabels } from "@agentonic/contracts/authoring"
import { beginReview } from "./actions"
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>
}) {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const workspaces = await reviewWorkspaces()
  if (!workspaces) throw new Error("No se pudo cargar la cola de revisión.")
  const q = await searchParams
  const selected = workspaces.find((w) => w.id === q.workspace) ?? workspaces[0]
  const queue = selected ? await loadReviewQueue(selected.id) : []
  if (!queue) throw new Error("No se pudo cargar la cola de revisión.")
  return (
    <>
      <PageHeader
        title="Revisiones"
        description="Propuestas que los clientes han autorizado a revisar. Abrir una propuesta registra el acceso a su versión exacta."
        count={queue?.length ?? 0}
      />
      {selected && (
        <WorkspacePicker
          workspaces={workspaces}
          selected={selected.id}
          base="/submissions"
        />
      )}
      <div className="space-y-4">
        {!queue?.length && (
          <Card>
            <CardHeader>
              <CardTitle>Sin propuestas pendientes</CardTitle>
              <CardDescription>
                Las propuestas aparecen cuando un cliente las envía con
                autorización vigente.
              </CardDescription>
            </CardHeader>
          </Card>
        )}
        {selected &&
          queue?.map((s) => (
            <Card key={s.id}>
              <CardHeader>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <CardTitle>
                    {s.agentName} · Propuesta {s.number}
                  </CardTitle>
                  <Badge variant="outline" className="rounded-full">
                    {submissionLabels[s.status] ?? s.status}
                  </Badge>
                </div>
                <CardDescription>
                  Versión sin evaluación de ejecución.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <MutationForm
                  action={beginReview.bind(null, selected.id, s.id)}
                  label="Abrir revisión"
                >
                  <p className="text-sm text-muted-foreground">
                    El consentimiento permite revisar la configuración y los
                    metadatos seleccionados, con vencimiento y auditoría.
                  </p>
                </MutationForm>
              </CardContent>
            </Card>
          ))}
      </div>
    </>
  )
}
