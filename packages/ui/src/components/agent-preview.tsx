"use client"
import {
  DEFAULT_MODEL_CONFIGURATION,
  modelCatalog,
  type ModelConfiguration,
} from "@agentonic/contracts/models"
import { ModelConfigurationSelect } from "@workspace/ui/components/model-configuration-select"
import { AgentAnswer } from "@workspace/ui/components/agent-answer"
import { useCallback, useEffect, useRef, useState } from "react"
import { PlayIcon, SendIcon, SquareIcon, MessageSquareIcon } from "lucide-react"
import {
  previewState,
  previewErrors,
  type PreviewState,
} from "@agentonic/contracts/preview"
import { Button } from "@workspace/ui/components/button"
import { Textarea } from "@workspace/ui/components/textarea"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@workspace/ui/components/select"
import { GmailApprovals } from "@workspace/ui/components/gmail-approvals"
import {
  previewModelName,
  type PreviewModel,
} from "@agentonic/contracts/preview-models"
const astraNote = "Astra puede necesitar el límite de US$3,00"
const astraNoteRestart = "Puedes elegirlo al iniciar otra prueba"
export function AgentPreview({
  workspaceId,
  agentId,
  candidateId,
  initialState = null,
}: {
  workspaceId: string
  agentId: string
  candidateId?: string
  initialState?: PreviewState | null
}) {
  const [previewId, setPreviewId] = useState<string | null>(
    initialState?.id ?? null
  )
  const [state, setState] = useState<PreviewState | null>(initialState)
  const [model, setModel] = useState<PreviewModel>(
    initialState?.turns.at(-1)?.model ?? DEFAULT_MODEL_CONFIGURATION.model
  )
  const [reasoning, setReasoning] = useState<ModelConfiguration["reasoning"]>(
    initialState?.turns.at(-1)?.reasoning ??
      modelCatalog.find((m) => m.id === model)!.defaultLevel
  )
  const [budgetUsd, setBudgetUsd] = useState<0.25 | 3>(0.25)
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const request = useRef<{
    query: string
    key: string
    model: PreviewModel
    reasoning: ModelConfiguration["reasoning"]
  } | null>(null)
  const locked = useRef(false)
  const generation = useRef(0)
  const bottom = useRef<HTMLDivElement>(null)
  const command = useCallback(
    async (operation: string, payload: Record<string, unknown>) => {
      const response = await fetch(`/api/previews?workspace=${workspaceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, payload: { agentId, ...payload } }),
        cache: "no-store",
      })
      if (!response.ok) throw new Error(previewErrors.unavailable)
      const result = (await response.json()) as {
        ok?: boolean
        code?: string
        id?: string
      }
      if (!result.ok)
        throw new Error(
          previewErrors[result.code ?? ""] ?? previewErrors.unavailable
        )
      return result
    },
    [workspaceId, agentId]
  )
  useEffect(() => {
    if (!previewId) return
    let stopped = false,
      pending = false
    const current = ++generation.current
    const refresh = async () => {
      if (pending || stopped) return
      pending = true
      try {
        const next = previewState.parse(await command("state", { previewId }))
        if (!stopped && generation.current === current) {
          setState(next)
          setError("")
        }
      } catch (reason) {
        if (!stopped && generation.current === current) {
          setState(null)
          setPreviewId(null)
          setError(
            reason instanceof Error
              ? reason.message
              : previewErrors.unavailable!
          )
        }
      } finally {
        pending = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [previewId, command])
  const last = state?.turns.at(-1)
  const waiting = !!last && ["queued", "running"].includes(last.status)
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "nearest" })
  }, [last?.id, last?.status])
  async function act(operation: "start" | "cancel" | "turn") {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError("")
    try {
      if (operation === "start") {
        const result = await command("start", {
          candidateId,
          enableTools: true,
          budgetUsd,
        })
        setState(
          previewState.parse(await command("state", { previewId: result.id }))
        )
        setPreviewId(result.id!)
        const url = new URL(window.location.href)
        url.searchParams.set("candidate", candidateId!)
        url.searchParams.set("preview", result.id!)
        window.history.replaceState(null, "", url)
        request.current = null
      } else if (operation === "cancel") {
        await command("cancel", { previewId })
        generation.current++
        setPreviewId(null)
        setState(null)
        setQuery("")
        const url = new URL(window.location.href)
        url.searchParams.delete("preview")
        window.history.replaceState(null, "", url)
        request.current = null
      } else {
        const text = query.trim()
        if (!text) return
        if (
          request.current?.query !== text ||
          request.current?.model !== model ||
          request.current?.reasoning !== reasoning
        )
          request.current = {
            query: text,
            key: crypto.randomUUID(),
            model,
            reasoning,
          }
        await command("turn", {
          previewId,
          query: text,
          requestKey: request.current.key,
          model: request.current.model,
          reasoning: request.current.reasoning,
        })
        setQuery("")
        request.current = null
        setState(previewState.parse(await command("state", { previewId })))
      }
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : previewErrors.unavailable!
      )
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return (
    <div className="space-y-6">
      <div className="space-y-4 rounded-lg border bg-card p-4 sm:p-6">
        {!candidateId && (
          <p className="text-sm text-muted-foreground">
            Prepara una versión desde la configuración del agente para probarla.
          </p>
        )}
        <div className="flex flex-wrap items-end justify-between gap-3">
          {previewId ? (
            <p className="self-center text-sm text-muted-foreground">
              Máximo US$
              {(state?.budgetUsd ?? budgetUsd).toFixed(2).replace(".", ",")} por
              prueba
            </p>
          ) : (
            <Field className="w-full sm:w-56">
              <FieldLabel htmlFor="preview-budget">
                Máximo por prueba
              </FieldLabel>
              <Select
                value={String(budgetUsd)}
                onValueChange={(value) =>
                  setBudgetUsd(value === "3" ? 3 : 0.25)
                }
                disabled={busy}
                items={[
                  { value: "0.25", label: "US$0,25" },
                  { value: "3", label: "US$3,00" },
                ]}
              >
                <SelectTrigger id="preview-budget" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0.25">US$0,25</SelectItem>
                  <SelectItem value="3">US$3,00</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          )}
          {previewId ? (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void act("cancel")}
            >
              <SquareIcon aria-hidden="true" />
              Finalizar prueba
            </Button>
          ) : (
            <Button
              disabled={busy || !candidateId}
              onClick={() => void act("start")}
            >
              <PlayIcon aria-hidden="true" />
              {busy ? "Iniciando…" : "Iniciar prueba"}
            </Button>
          )}
        </div>
      </div>
      {previewId && state?.gmailEnabled && (
        <GmailApprovals
          key={previewId}
          workspaceId={workspaceId}
          conversationId={previewId}
          context="preview"
        />
      )}
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
          <Field className="flex-1">
            <FieldLabel htmlFor="preview-model">
              Selecciona un modelo
            </FieldLabel>
            <div>
              <ModelConfigurationSelect
                id="preview-model"
                className="min-w-56"
                value={{ model, reasoning }}
                disabled={busy || waiting}
                onChange={(choice) => {
                  setModel(choice.model)
                  setReasoning(choice.reasoning)
                }}
              />
            </div>
            {/* The longest note always reserves its space, so choosing Astra
                does not move the conversation below. */}
            <p className="grid text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className="invisible col-start-1 row-start-1"
              >
                {astraNote}. {astraNoteRestart}.
              </span>
              <span className="col-start-1 row-start-1">
                {model === "gpt-6-astra" &&
                  (state?.budgetUsd ?? budgetUsd) < 3 &&
                  (previewId
                    ? `${astraNote}. ${astraNoteRestart}.`
                    : `${astraNote}.`)}
              </span>
            </p>
          </Field>
          <span className="text-sm text-muted-foreground">
            {previewId
              ? `${state?.turns.length ?? 0} de 10 mensajes`
              : "Sin iniciar"}
          </span>
        </div>
        <div
          className="max-h-[55vh] min-h-64 space-y-6 overflow-y-auto p-6"
          role="log"
          aria-label="Mensajes de la prueba"
          aria-live="polite"
        >
          {!state?.turns.length && (
            <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
              <MessageSquareIcon className="size-6" aria-hidden="true" />
              <p className="text-sm">
                {previewId
                  ? "Escribe una pregunta para probar esta versión."
                  : "Inicia una prueba para conversar con tu agente."}
              </p>
            </div>
          )}
          {state?.turns.map((turn) => (
            <div key={turn.id} className="space-y-4">
              <div className="ml-auto max-w-[90%] rounded-lg border bg-muted/40 px-4 py-3">
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  Tú
                </p>
                <p className="text-sm break-words whitespace-pre-wrap">
                  {turn.query}
                </p>
              </div>
              <div className="space-y-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Agente · Prueba · {previewModelName(turn.model)}
                </p>
                {turn.answer ? (
                  <>
                    <AgentAnswer text={turn.answer.text} />
                    {turn.answer.citations.length > 0 && (
                      <details className="rounded-md border p-3">
                        <summary className="cursor-pointer text-xs font-medium">
                          Fuentes consultadas ({turn.answer.citations.length})
                        </summary>
                        <div className="mt-3 space-y-4">
                          {turn.matches
                            .filter((m) =>
                              turn.answer!.citations.includes(m.id)
                            )
                            .map((m) => (
                              <div key={m.id} className="space-y-1">
                                <p className="text-xs font-medium">
                                  {m.title}
                                  {m.locator.page
                                    ? ` · Página ${m.locator.page}`
                                    : ""}
                                </p>
                                <p className="text-xs break-words whitespace-pre-wrap text-muted-foreground">
                                  {m.text}
                                </p>
                              </div>
                            ))}
                        </div>
                      </details>
                    )}
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {turn.status === "queued"
                      ? "En cola. Esperando al servicio de pruebas…"
                      : turn.status === "running"
                        ? "Preparando respuesta…"
                        : (previewErrors[turn.error ?? ""] ??
                          "No se pudo completar esta respuesta.")}
                  </p>
                )}
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void act("turn")
          }}
          className="space-y-3 border-t p-4 sm:p-6"
        >
          <Field>
            <FieldLabel htmlFor="preview-message">Mensaje</FieldLabel>
            <Textarea
              id="preview-message"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              maxLength={1000}
              placeholder="Pregunta sobre el conocimiento de tu agente…"
              disabled={
                !previewId ||
                busy ||
                waiting ||
                (state?.turns.length ?? 0) >= 10
              }
              className="min-h-20 resize-y"
            />
          </Field>
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">{query.length}/1000</p>
            <Button
              type="submit"
              disabled={
                !previewId ||
                busy ||
                waiting ||
                !query.trim() ||
                (state?.turns.length ?? 0) >= 10
              }
            >
              <SendIcon aria-hidden="true" />
              Enviar mensaje
            </Button>
          </div>
        </form>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
