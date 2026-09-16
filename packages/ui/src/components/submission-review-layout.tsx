import type { ReactNode } from "react"
import type { FormResult, ReviewView } from "@agentonic/contracts/authoring"
import {
  ScrollTextIcon,
  ListChecksIcon,
  LibraryBigIcon,
  MessageSquareTextIcon,
} from "lucide-react"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
import { RecordHeader, BackRow } from "@workspace/ui/components/record-header"
import { Badge } from "@workspace/ui/components/badge"
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

const decisions = [
  { value: "in_review", label: "Mantener en revisión" },
  { value: "changes_requested", label: "Solicitar cambios" },
  { value: "rejected", label: "Rechazar propuesta" },
]

export function SubmissionReviewLayout({
  review,
  backHref,
  testsPassed,
  needsAttention,
  evaluation,
  history,
  decideAction,
  canDecide = false,
}: {
  review: ReviewView
  backHref: string
  testsPassed: boolean
  needsAttention: boolean
  evaluation: ReactNode
  history?: ReactNode
  decideAction: (data: FormData) => Promise<FormResult>
  canDecide?: boolean
}) {
  const collections = review.requestedAccess.collectionIds.length
  return (
    <div className="mx-auto w-full max-w-4xl space-y-6">
      <BackRow href={backHref} />
      <RecordHeader
        title={review.agentName}
        description={`Propuesta ${review.number} · Revisa la versión enviada por el cliente.`}
        actions={
          <Badge variant={testsPassed ? "success" : "slate"}>
            {testsPassed ? "Pruebas superadas" : "Sin evaluación superada"}
          </Badge>
        }
      />
      <SubmissionVersionContent
        content={review.content}
        collectionCount={collections}
      />
      {evaluation}
      {history}
      <AgentSettingsCard
        title="Atender revisión"
        icon={<MessageSquareTextIcon />}
        description="Revisa los resultados de la evaluación antes de registrar una decisión. Explica al cliente qué debe ajustar o por qué su propuesta necesita atención."
        action={
          needsAttention ? (
            <Badge variant="warning">Requiere atención</Badge>
          ) : undefined
        }
      >
        <div className="space-y-5">
          {!canDecide && (
            <p className="text-sm text-muted-foreground">
              Disponible cuando el cliente confirme los criterios y termine la
              evaluación.
            </p>
          )}
          {review.note && (
            <div className="space-y-2 rounded-lg border bg-muted/20 p-4">
              <h3 className="text-sm font-medium">Nota del cliente</h3>
              <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
                {review.note}
              </p>
            </div>
          )}
          <div className="border-t pt-5">
            <MutationForm
              action={decideAction}
              label="Registrar decisión"
              disabled={!canDecide}
            >
              <Field>
                <FieldLabel htmlFor="review-decision">
                  Decisión del equipo
                </FieldLabel>
                <Select
                  name="decision"
                  defaultValue="changes_requested"
                  items={decisions}
                >
                  <SelectTrigger
                    id="review-decision"
                    className="w-full sm:max-w-sm"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {decisions.map((decision) => (
                      <SelectItem key={decision.value} value={decision.value}>
                        {decision.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="feedback">
                  Comentarios al cliente
                </FieldLabel>
                <Textarea
                  id="feedback"
                  name="feedback"
                  required
                  maxLength={2000}
                  className="min-h-40"
                  placeholder="Describe los ajustes necesarios y los próximos pasos."
                />
              </Field>
            </MutationForm>
          </div>
        </div>
      </AgentSettingsCard>
    </div>
  )
}

export function SubmissionVersionContent({
  content,
  collectionCount,
  collectionNames,
}: {
  content: ReviewView["content"]
  collectionCount: number
  collectionNames?: string[]
}) {
  return (
    <>
      <AgentSettingsCard
        title="Instrucciones del sistema"
        icon={<ScrollTextIcon />}
        description="El comportamiento y los límites definidos para esta versión."
      >
        <div className="rounded-lg border bg-muted/20 p-4 sm:p-5">
          <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">
            {content.systemPrompt}
          </p>
        </div>
      </AgentSettingsCard>
      <AgentSettingsCard
        title="Habilidades"
        icon={<ListChecksIcon />}
        description="Instrucciones específicas que complementan el comportamiento del agente."
        action={
          <Badge variant="slate">
            {content.skills.length}{" "}
            {content.skills.length === 1 ? "habilidad" : "habilidades"}
          </Badge>
        }
      >
        <div className="divide-y border-t">
          {content.skills.length ? (
            content.skills.map((skill) => (
              <div
                key={skill.name}
                className="space-y-2 py-5 first:pt-4 last:pb-0"
              >
                <h3 className="text-sm font-medium">{skill.name}</h3>
                <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
                  {skill.instructions}
                </p>
              </div>
            ))
          ) : (
            <p className="pt-5 text-sm text-muted-foreground">
              Sin habilidades adicionales.
            </p>
          )}
        </div>
      </AgentSettingsCard>
      <AgentSettingsCard
        title="Conocimiento solicitado"
        icon={<LibraryBigIcon />}
        description="Colecciones que el cliente propone como fuente de información."
        action={
          <Badge variant="slate">
            {collectionCount}{" "}
            {collectionCount === 1 ? "colección" : "colecciones"}
          </Badge>
        }
        footer="La selección de colecciones no activa el acceso del agente."
      >
        {collectionNames?.length ? (
          <ul className="space-y-2 text-sm">
            {collectionNames.map((name, index) => (
              <li key={index}>{name}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm leading-relaxed text-muted-foreground">
            {collectionCount
              ? "Esta revisión permite consultar los metadatos de las colecciones, sin acceso al contenido de sus documentos."
              : "El cliente no solicitó colecciones de conocimiento para esta versión."}
          </p>
        )}
      </AgentSettingsCard>
    </>
  )
}
