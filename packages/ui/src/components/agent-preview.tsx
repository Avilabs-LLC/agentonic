"use client"
import { useCallback, useEffect, useRef, useState } from "react"
import { PlayIcon, SendIcon, SquareIcon, MessageSquareIcon } from "lucide-react"
import {
  previewState,
  previewErrors,
  type PreviewState,
} from "@agentonic/contracts/preview"
import { Button } from "@workspace/ui/components/button"
import { Badge } from "@workspace/ui/components/badge"
import { Textarea } from "@workspace/ui/components/textarea"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@workspace/ui/components/select"
import { AgentSettingsCard } from "@workspace/ui/components/agent-settings-card"
export function AgentPreview({
  workspaceId,
  agentId,
  candidates,
  initialCandidateId,
  initialState = null,
}: {
  workspaceId: string
  agentId: string
  candidates: { id: string; version: string; hash: string }[]
  initialCandidateId?: string
  initialState?: PreviewState | null
}) {
  const [candidate, setCandidate] = useState(
    initialCandidateId ?? candidates[0]?.id ?? ""
  )
  const [previewId, setPreviewId] = useState<string | null>(
    initialState?.id ?? null
  )
  const [state, setState] = useState<PreviewState | null>(initialState)
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const request = useRef<{ query: string; key: string } | null>(null)
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
        const result = await command("start", { candidateId: candidate })
        setPreviewId(result.id!)
        request.current = null
      } else if (operation === "cancel") {
        await command("cancel", { previewId })
        generation.current++
        setPreviewId(null)
        setState(null)
        setQuery("")
        request.current = null
      } else {
        const text = query.trim()
        if (!text) return
        if (request.current?.query !== text)
          request.current = { query: text, key: crypto.randomUUID() }
        await command("turn", {
          previewId,
          query: text,
          requestKey: request.current.key,
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
      <AgentSettingsCard
        title="Versión de prueba"
        description="Solo tú puedes ver esta conversación. Termina a los 10 minutos o al alcanzar 10 mensajes."
      >
        <div className="space-y-4">
          <Field>
            <FieldLabel htmlFor="preview-candidate">
              Versión preparada
            </FieldLabel>
            <Select
              value={candidate || null}
              onValueChange={(value) => setCandidate(value ?? "")}
              items={candidates.map((c) => ({ value: c.id, label: c.version }))}
              disabled={!!previewId || busy}
            >
              <SelectTrigger id="preview-candidate" className="w-full">
                <SelectValue placeholder="Sin versiones compatibles" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.version}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {!candidates.length && (
            <p className="text-sm text-muted-foreground">
              Guarda el borrador y usa Preparar versión desde la configuración
              del agente.
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              Máximo US$0,25 por prueba · Fuentes de prueba · Sin acciones
              externas
            </p>
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
                disabled={busy || !candidate}
                onClick={() => void act("start")}
              >
                <PlayIcon aria-hidden="true" />
                {busy ? "Iniciando…" : "Iniciar prueba"}
              </Button>
            )}
          </div>
        </div>
      </AgentSettingsCard>
      <div className="overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
          <h2 className="font-medium">Conversación de prueba</h2>
          <Badge variant={previewId ? "sky" : "slate"}>
            {previewId
              ? `${state?.turns.length ?? 0} de 10 mensajes`
              : "Sin iniciar"}
          </Badge>
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
                  Agente · Prueba
                </p>
                {turn.answer ? (
                  <>
                    <p className="text-sm break-words whitespace-pre-wrap">
                      {turn.answer.text}
                    </p>
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
