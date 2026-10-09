import { GmailScopeSummary } from "@workspace/ui/components/gmail-scope-summary"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
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
import {
  SubmissionStatusBadge,
  DomainStatus,
} from "@workspace/ui/components/status-badge"
import { MutationForm } from "@workspace/ui/components/mutation-form"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Textarea } from "@workspace/ui/components/textarea"
import { MarkdownView } from "@workspace/ui/components/markdown"
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
        actions={<SubmissionStatusBadge status={review.status} />}
      />
      <p className="text-sm text-muted-foreground">
        {testsPassed
          ? "Hay pruebas superadas en el historial. Consulta la revisión actual antes de decidir."
          : "No hay una evaluación superada registrada."}
      </p>
      <SubmissionVersionContent
        content={review.content}
        collectionCount={collections}
        tools={review.requestedAccess.tools}
      />
      {evaluation}
      {history}
      <AgentSettingsCard
        title="Atender revisión"
        icon={<MessageSquareTextIcon />}
        description="Revisa los resultados de la evaluación antes de registrar una decisión. Explica al cliente qué debe ajustar o por qué su propuesta necesita atención."
        action={
          needsAttention ? (
            <DomainStatus domain="review" status="needs_attention" />
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
  tools,
}: {
  content: ReviewView["content"]
  collectionCount: number
  tools?: ReviewView["requestedAccess"]["tools"]
  collectionNames?: string[]
}) {
  return (
    <>
      {tools?.length ? <GmailScopeSummary tools={tools} /> : null}
      <AgentSettingsCard
        title="Instrucciones del sistema"
        icon={<ScrollTextIcon />}
        description="El comportamiento y los límites definidos para esta versión."
      >
        <MarkdownView
          markdown={content.systemPrompt}
          paneClassName="max-h-[min(32rem,60dvh)] p-4 sm:p-5"
          empty="Sin instrucciones."
        />
      </AgentSettingsCard>
      <AgentSettingsCard
        title="Habilidades"
        icon={<ListChecksIcon />}
        description="Instrucciones específicas que complementan el comportamiento del agente."
        action={
          <span className="text-sm text-muted-foreground tabular-nums">
            {content.skills.length}{" "}
            {content.skills.length === 1 ? "habilidad" : "habilidades"}
          </span>
        }
      >
        <div className="divide-y border-t">
          {content.skills.length ? (
            content.skills.map((skill) => (
              <div
                key={skill.name}
                className="space-y-2 py-5 first:pt-4 last:pb-0"
              >
                <MarkdownView
                  label={<h3 className="text-sm font-medium">{skill.name}</h3>}
                  markdown={skill.instructions}
                  paneClassName="max-h-[min(20rem,45dvh)] p-4"
                />
              </div>
            ))
          ) : (
            <CardEmptyState title="Sin habilidades adicionales">
              Esta versión utiliza las instrucciones del sistema.
            </CardEmptyState>
          )}
        </div>
      </AgentSettingsCard>
      <AgentSettingsCard
        title="Conocimiento solicitado"
        icon={<LibraryBigIcon />}
        description="Colecciones que el cliente propone como fuente de información."
        action={
          <span className="text-sm text-muted-foreground tabular-nums">
            {collectionCount}{" "}
            {collectionCount === 1 ? "colección" : "colecciones"}
          </span>
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
          <CardEmptyState
            title={
              collectionCount
                ? "Contenido restringido"
                : "Sin conocimiento solicitado"
            }
          >
            {collectionCount
              ? "Esta revisión permite consultar los metadatos de las colecciones, sin acceso al contenido de sus documentos."
              : "El cliente no solicitó colecciones de conocimiento para esta versión."}
          </CardEmptyState>
        )}
      </AgentSettingsCard>
    </>
  )
}
