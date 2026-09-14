import { notFound } from "next/navigation"
import { openReview } from "@agentonic/server/authoring"
import { RecordHeader, BackRow } from "@workspace/ui/components/record-header"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@workspace/ui/components/card"
import { MutationForm } from "@workspace/ui/components/mutation-form"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Textarea } from "@workspace/ui/components/textarea"
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@workspace/ui/components/select"
import { Badge } from "@workspace/ui/components/badge"
import { decideReview } from "../actions"
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ workspace?: string; grant?: string }>
}) {
  const { id } = await params
  const q = await searchParams
  if (!q.workspace || !q.grant) notFound()
  const review = await openReview(q.workspace, id, q.grant)
  if (!review) notFound()
  const decisions = [
    { value: "in_review", label: "Mantener en revisión" },
    { value: "changes_requested", label: "Solicitar cambios" },
    { value: "rejected", label: "Rechazar propuesta" },
  ]
  return (
    <>
      <BackRow href={`/submissions?workspace=${q.workspace}`} />
      <RecordHeader
        title={`${review.agentName} · Propuesta ${review.number}`}
        description="Solo esta versión y el alcance autorizado por el cliente."
        actions={
          <Badge variant="warning">
            Sin evaluar
          </Badge>
        }
      />
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Instrucciones del sistema</CardTitle>
              <CardDescription>
                Contenido del cliente; no constituye una autorización para
                ejecutar herramientas.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm break-words whitespace-pre-wrap">
                {review.content.systemPrompt}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Habilidades</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {review.content.skills.length ? (
                review.content.skills.map((s) => (
                  <div key={s.name} className="space-y-2">
                    <h3 className="font-medium">{s.name}</h3>
                    <p className="text-sm break-words whitespace-pre-wrap">
                      {s.instructions}
                    </p>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  Sin habilidades adicionales.
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Conocimiento solicitado</CardTitle>
              <CardDescription>
                {review.requestedAccess.collectionIds.length} colecciones
                propuestas. Su selección no activa acceso del agente.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                Esta revisión permite metadatos; no concede acceso al contenido
                de los documentos.
              </p>
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Comentarios al cliente</CardTitle>
            <CardDescription>
              La aprobación y el despliegue se habilitarán con los controles de
              evaluación y ejecución.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {review.note && (
              <p className="mb-4 rounded-lg border p-3 text-sm whitespace-pre-wrap">
                {review.note}
              </p>
            )}
            <MutationForm
              action={decideReview.bind(null, q.workspace, id, q.grant)}
              label="Registrar decisión"
            >
              <Field>
                <FieldLabel>Decisión</FieldLabel>
                <Select
                  name="decision"
                  defaultValue="changes_requested"
                  items={decisions}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {decisions.map((d) => (
                      <SelectItem key={d.value} value={d.value}>
                        {d.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="feedback">Comentarios</FieldLabel>
                <Textarea
                  id="feedback"
                  name="feedback"
                  required
                  maxLength={2000}
                  className="min-h-40"
                />
              </Field>
            </MutationForm>
          </CardContent>
        </Card>
      </div>
    </>
  )
}
