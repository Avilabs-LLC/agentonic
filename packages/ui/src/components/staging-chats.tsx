"use client"
import {
  DEFAULT_MODEL_CONFIGURATION,
  modelConfigurationKey,
  type ModelConfiguration,
} from "@agentonic/contracts/models"
import { ModelConfigurationSelect } from "@workspace/ui/components/model-configuration-select"
import { AgentAnswer } from "@workspace/ui/components/agent-answer"
import { GmailApprovals } from "@workspace/ui/components/gmail-approvals"
import { formatUtcMinute } from "@agentonic/contracts/format"
import {
  customerEnvironmentLabels,
  unavailableOnOurSide,
} from "@agentonic/contracts/availability"
import { CardEmptyState } from "@workspace/ui/components/card-empty-state"
import { useCallback, useEffect, useId, useRef, useState } from "react"
import type { z } from "zod"
import { MessageSquareIcon, SendIcon, Loader2Icon } from "lucide-react"
import {
  chatList,
  chatState,
  lifecycleErrors,
  type ChatState,
} from "@agentonic/contracts/lifecycle"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
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
import { RecordHeader } from "@workspace/ui/components/record-header"
const agentLabel = (agent: z.infer<typeof chatList>["agents"][number]) =>
  `${agent.name} · ${customerEnvironmentLabels[agent.environment]}`
export function StagingChats({
  workspaceId,
  initial,
  initialDeployment,
}: {
  workspaceId: string
  initial: z.infer<typeof chatList>
  initialDeployment?: string
}) {
  const fieldId = useId(),
    lock = useRef(false),
    epoch = useRef(0)
  const [listing, setListing] = useState(initial),
    [selected, setSelected] = useState<string | null>(null),
    [state, setState] = useState<ChatState | null>(null)
  const [deployment, setDeployment] = useState(
    initial.agents.some((a) => a.id === initialDeployment)
      ? initialDeployment!
      : (initial.agents[0]?.id ?? "")
  )
  const [search, setSearch] = useState(""),
    [title, setTitle] = useState(""),
    [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false)
  const [chosenModel, setChosenModel] = useState<ModelConfiguration>(
    DEFAULT_MODEL_CONFIGURATION
  )
  const configuration =
    state?.models.find(
      (m) => modelConfigurationKey(m) === modelConfigurationKey(chosenModel)
    ) ??
    state?.models[0] ??
    chosenModel
  const request = useRef<{
    query: string
    id: string
    configuration: string
  } | null>(null)
  const command = useCallback(
    async (operation: string, payload: Record<string, unknown> = {}) => {
      const response = await fetch(`/api/chats?workspace=${workspaceId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, payload }),
        cache: "no-store",
      })
      if (!response.ok) throw new Error(lifecycleErrors.unavailable)
      const result = (await response.json()) as {
        ok: boolean
        code?: string
        id?: string
      }
      if (!result.ok)
        throw new Error(
          lifecycleErrors[result.code ?? ""] ?? lifecycleErrors.unavailable
        )
      return result
    },
    [workspaceId]
  )
  useEffect(() => {
    let stopped = false,
      inFlight = false
    const current = ++epoch.current
    const refresh = async () => {
      if (inFlight || stopped) return
      inFlight = true
      try {
        if (selected) {
          const next = chatState.parse(
            await command("state", { conversationId: selected })
          )
          if (!stopped && current === epoch.current) setState(next)
        }
        const nextList = chatList.parse(await command("list"))
        if (!stopped && current === epoch.current) setListing(nextList)
      } catch (reason) {
        if (!stopped && current === epoch.current) {
          setState(null)
          setListing({ ok: true, agents: [], conversations: [] })
          setError(
            reason instanceof Error
              ? reason.message
              : lifecycleErrors.unavailable!
          )
        }
      } finally {
        inFlight = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [selected, command])
  async function run(operation: "start" | "turn" | "close") {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError("")
    const current = epoch.current
    try {
      if (operation === "start") {
        const r = await command("start", {
          deploymentId: deployment,
          title: title.trim() || "Nueva conversación",
        })
        setSelected(r.id!)
        setState(null)
        setTitle("")
      } else if (operation === "turn" && selected) {
        if (
          !request.current ||
          request.current.query !== query ||
          request.current.configuration !== modelConfigurationKey(configuration)
        )
          request.current = {
            query,
            id: crypto.randomUUID(),
            configuration: modelConfigurationKey(configuration),
          }
        await command("turn", {
          conversationId: selected,
          query,
          requestId: request.current.id,
          model: configuration.model,
          reasoning: configuration.reasoning,
        })
        if (current === epoch.current) {
          setQuery("")
          request.current = null
          setState(
            chatState.parse(
              await command("state", { conversationId: selected })
            )
          )
        }
      } else if (operation === "close" && selected) {
        await command("close", { conversationId: selected })
        setSelected(null)
        setState(null)
        setListing(chatList.parse(await command("list")))
      }
    } catch (reason) {
      if (current === epoch.current)
        setError(
          reason instanceof Error
            ? reason.message
            : lifecycleErrors.unavailable!
        )
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const term = search.toLocaleLowerCase("es-VE"),
    last = state?.turns.at(-1),
    waiting = last?.status === "queued" || last?.status === "running"
  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <RecordHeader
        title="Chats"
        description="Conversaciones privadas con tus agentes activos en pruebas. Solo tú puedes consultar estos mensajes."
      />
      <div className="grid gap-6 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-6">
          <AgentSettingsCard
            title="Conversaciones"
            description="Busca y retoma tus conversaciones privadas."
            icon={<MessageSquareIcon />}
          >
            <Input
              aria-label="Buscar conversaciones o agentes"
              placeholder="Buscar conversaciones o agentes"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="mt-4 space-y-2">
              {listing.conversations
                .filter((c) =>
                  `${c.title} ${c.agentName}`
                    .toLocaleLowerCase("es-VE")
                    .includes(term)
                )
                .map((c) => (
                  <Button
                    key={c.id}
                    variant={selected === c.id ? "secondary" : "ghost"}
                    className="h-auto w-full justify-start py-3 text-left whitespace-normal"
                    disabled={busy}
                    onClick={() => {
                      epoch.current++
                      setSelected(c.id)
                      setState(null)
                      setError("")
                      request.current = null
                    }}
                  >
                    <span>
                      <span className="block">{c.title}</span>
                      <span className="block text-xs text-muted-foreground">
                        {c.agentName}
                      </span>
                    </span>
                  </Button>
                ))}
              {!listing.conversations.length && (
                <CardEmptyState title="Sin conversaciones">
                  Abre una conversación con un agente activo para empezar.
                </CardEmptyState>
              )}
            </div>
          </AgentSettingsCard>
          <AgentSettingsCard
            title="Nueva conversación"
            description="Elige un agente activo y un título."
            icon={<MessageSquareIcon />}
          >
            {!listing.agents.length ? (
              <CardEmptyState title="Sin agentes disponibles">
                Activa una versión desde la pestaña Activación de tu agente para
                empezar.
              </CardEmptyState>
            ) : (
              <div className="space-y-4">
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-agent`}>Agente</FieldLabel>
                  <Select
                    value={deployment}
                    items={listing.agents.map((a) => ({
                      value: a.id,
                      label: agentLabel(a),
                    }))}
                    onValueChange={(v) => setDeployment(v ?? "")}
                  >
                    <SelectTrigger id={`${fieldId}-agent`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {listing.agents
                        .filter((a) =>
                          a.name.toLocaleLowerCase("es-VE").includes(term)
                        )
                        .map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {agentLabel(a)}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-title`}>Título</FieldLabel>
                  <Input
                    id={`${fieldId}-title`}
                    value={title}
                    maxLength={100}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Nueva conversación"
                  />
                </Field>
                <Button
                  disabled={
                    busy || !listing.agents.some((a) => a.id === deployment)
                  }
                  onClick={() => void run("start")}
                >
                  Abrir conversación
                </Button>
              </div>
            )}
          </AgentSettingsCard>
        </div>
        <AgentSettingsCard
          title={state?.title ?? "Tu conversación"}
          description="Las respuestas usan la versión activada y sus fuentes autorizadas."
          icon={<MessageSquareIcon />}
          action={
            state ? (
              <span className="text-sm text-muted-foreground">
                {state.online ? "Disponible" : "No disponible por ahora"}
              </span>
            ) : undefined
          }
        >
          {!selected ? (
            <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-muted/20 p-6 text-center text-muted-foreground">
              <MessageSquareIcon className="size-10" />
              <p>Abre una conversación para hablar con tu agente.</p>
            </div>
          ) : !state ? (
            <div className="flex min-h-80 items-center justify-center">
              {!error && <Loader2Icon className="animate-spin" />}
            </div>
          ) : (
            <>
              <GmailApprovals
                key={selected}
                workspaceId={workspaceId}
                conversationId={selected}
              />
              <div className="min-h-64 space-y-5" role="log" aria-live="polite">
                {state.turns.map((t) => (
                  <div key={t.id} className="space-y-3">
                    <div className="ml-6 rounded-xl bg-muted p-4">
                      <p className="mb-1 text-xs text-muted-foreground">Tú</p>
                      <p className="text-sm whitespace-pre-wrap">{t.query}</p>
                    </div>
                    <div className="mr-6 rounded-xl border p-4">
                      <p className="mb-1 text-xs text-muted-foreground">
                        Agente
                      </p>
                      {t.answer ? (
                        <AgentAnswer text={t.answer} />
                      ) : t.status === "failed" ? (
                        <p className="text-sm text-destructive">
                          {lifecycleErrors[t.errorCode ?? ""] ??
                            "No se pudo completar la respuesta."}
                        </p>
                      ) : (
                        <p className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Loader2Icon className="size-4 animate-spin" />
                          Preparando respuesta…
                        </p>
                      )}
                      {t.citations.length > 0 && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          Respuesta respaldada por {t.citations.length}{" "}
                          {t.citations.length === 1
                            ? "referencia autorizada"
                            : "referencias autorizadas"}
                          .
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
              {!state.online && (
                <p className="mt-6 text-sm text-muted-foreground">
                  {unavailableOnOurSide} Podrás escribir cuando vuelva a estar
                  disponible; esta conversación se conserva.
                </p>
              )}
              <form
                className="mt-6 space-y-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  void run("turn")
                }}
              >
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-message`}>
                    Mensaje
                  </FieldLabel>
                  <ModelConfigurationSelect
                    value={configuration}
                    onChange={setChosenModel}
                    options={state?.models ?? []}
                    disabled={
                      busy ||
                      !!state?.turns.some((t) =>
                        ["queued", "running"].includes(t.status)
                      )
                    }
                  />
                  <Textarea
                    id={`${fieldId}-message`}
                    value={query}
                    maxLength={1000}
                    disabled={busy || waiting || !state.online}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Escribe tu pregunta"
                  />
                </Field>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void run("close")}
                  >
                    Cerrar y borrar mensajes
                  </Button>
                  <Button
                    type="submit"
                    disabled={busy || waiting || !state.online || !query.trim()}
                  >
                    <SendIcon />
                    Enviar
                  </Button>
                </div>
              </form>
              <p className="mt-4 text-xs text-muted-foreground">
                Consumo: USD {(state.committedMicrousd / 1e6).toFixed(4)} de USD{" "}
                {state.budgetUsd.toFixed(2)} autorizados. Esta conversación y
                sus mensajes están disponibles hasta el{" "}
                {formatUtcMinute(state.expiresAt)}.
              </p>
            </>
          )}
          {error && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {error}
            </p>
          )}
        </AgentSettingsCard>
      </div>
    </div>
  )
}
