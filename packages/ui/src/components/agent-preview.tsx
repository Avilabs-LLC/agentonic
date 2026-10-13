"use client"
import {
  DEFAULT_MODEL_CONFIGURATION,
  modelCatalog,
  modelConfigurationKey,
  OLD_RUNTIME_MODELS_NOTE,
  selectableConfigurationsFor,
  type ModelConfiguration,
} from "@agentonic/contracts/models"
import { formatUsd } from "@agentonic/contracts/format"
import { ModelPicker } from "@workspace/ui/components/model-picker"
import { ChatComposer } from "@workspace/ui/components/chat-composer"
import { AgentAnswer } from "@workspace/ui/components/agent-answer"
import { TurnSteps, thinking } from "@workspace/ui/components/turn-steps"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  Loader2Icon,
  PlayIcon,
  SquareIcon,
  MessageSquareIcon,
} from "lucide-react"
import {
  previewState,
  previewErrors,
  type PreviewState,
} from "@agentonic/contracts/preview"
import { Button } from "@workspace/ui/components/button"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@workspace/ui/components/select"
import { GmailApprovals } from "@workspace/ui/components/gmail-approvals"
import { DriveApprovals } from "@workspace/ui/components/drive-approvals"
import {
  previewModelName,
  type PreviewModel,
} from "@agentonic/contracts/preview-models"
// Models whose output costs US$20 per million tokens or more (GPT-6 Astra,
// GPT-5.6 Sol) can reserve more than US$0,25 on one long call (§77).
const needsLargerLimit = (id: string) =>
  (modelCatalog.find((m) => m.id === id)?.outputRate ?? 0) >= 20
const largerLimitNote = (id: string) =>
  `${modelCatalog.find((m) => m.id === id)?.name ?? id} puede necesitar el límite de US$3,00`
const largerLimitRestart = "Puedes elegirlo al iniciar otra prueba"
export function AgentPreview({
  workspaceId,
  agentId,
  candidateId,
  openModels = false,
  initialState = null,
}: {
  workspaceId: string
  agentId: string
  candidateId?: string
  /** The version's runtime accepts any offered model (0.8.0, §77). */
  openModels?: boolean
  initialState?: PreviewState | null
}) {
  const options = selectableConfigurationsFor(openModels)
  const offered = (c: ModelConfiguration) =>
    options.some((o) => modelConfigurationKey(o) === modelConfigurationKey(c))
  const [previewId, setPreviewId] = useState<string | null>(
    initialState?.id ?? null
  )
  const [state, setState] = useState<PreviewState | null>(initialState)
  // A model no longer offered, or that the version's runtime can't run,
  // falls back to the default, or to the first model it can run.
  const lastOffered = initialState?.turns
    .filter((turn) =>
      offered({ model: turn.model, reasoning: turn.reasoning ?? null })
    )
    .at(-1)
  const [model, setModel] = useState<PreviewModel>(
    lastOffered?.model ??
      (offered(DEFAULT_MODEL_CONFIGURATION)
        ? DEFAULT_MODEL_CONFIGURATION.model
        : (options[0]?.model ?? DEFAULT_MODEL_CONFIGURATION.model))
  )
  const [reasoning, setReasoning] = useState<ModelConfiguration["reasoning"]>(
    lastOffered?.reasoning ??
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
  const live = useRef(false)
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
          live.current = next.turns.some(
            (t) => t.status === "running" || t.status === "queued"
          )
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
    // A turn in progress is followed every second, so its answer appears
    // as it is written (§68).
    let timer: ReturnType<typeof setTimeout> | undefined
    const loop = async () => {
      await refresh()
      if (!stopped) timer = setTimeout(loop, live.current ? 1000 : 2000)
    }
    void loop()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [previewId, command])
  const last = state?.turns.at(-1),
    turnCount = state?.turns.length ?? 0
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
              Máximo {formatUsd(state?.budgetUsd ?? budgetUsd)} por prueba
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
      {previewId && state?.toolsEnabled && (
        <DriveApprovals
          key={`drive:${previewId}`}
          workspaceId={workspaceId}
          conversationId={previewId}
          context="preview"
        />
      )}
      <div className="overflow-hidden rounded-lg border bg-card">
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
                <TurnSteps
                  steps={turn.steps}
                  live={turn.status === "queued" || turn.status === "running"}
                />
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
                ) : turn.status === "running" && turn.partial ? (
                  <>
                    <AgentAnswer text={turn.partial} />
                    <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2Icon className="size-3 animate-spin" />
                      Escribiendo…
                    </p>
                  </>
                ) : turn.status === "running" && turn.steps?.length ? (
                  // A running step shows its own spinner (§74).
                  thinking(turn.steps) && (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2Icon className="size-3 animate-spin" />
                      Pensando…
                    </p>
                  )
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
        <div className="border-t p-4 sm:p-6">
          <ChatComposer
            id="preview-message"
            value={query}
            onChange={setQuery}
            onSubmit={() => void act("turn")}
            placeholder="Pregunta sobre el conocimiento de tu agente…"
            disabled={!previewId || busy || waiting || turnCount >= 10}
            canSubmit={
              !!previewId &&
              !busy &&
              !waiting &&
              !!query.trim() &&
              turnCount < 10
            }
            model={
              <ModelPicker
                value={{ model, reasoning }}
                options={options}
                note={openModels ? undefined : OLD_RUNTIME_MODELS_NOTE}
                disabled={busy || waiting}
                onChange={(choice) => {
                  setModel(choice.model)
                  setReasoning(choice.reasoning)
                }}
              />
            }
            tray={
              <>
                <p className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                  <span>
                    {previewId ? `${turnCount} de 10 mensajes` : "Sin iniciar"}
                  </span>
                  <span className="tabular-nums">{query.length}/1000</span>
                </p>
                {needsLargerLimit(model) &&
                  (state?.budgetUsd ?? budgetUsd) < 3 && (
                    <p className="mt-1">
                      {previewId
                        ? `${largerLimitNote(model)}. ${largerLimitRestart}.`
                        : `${largerLimitNote(model)}.`}
                    </p>
                  )}
              </>
            }
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
