import { randomUUID } from "node:crypto"
import { fork } from "node:child_process"
import { z } from "zod"
import { gmailArguments, gmailReads } from "@agentonic/contracts/gmail"
import type { gmailGrant } from "@agentonic/contracts/gmail"
import { webArguments, type WebOperation } from "@agentonic/contracts/web"
import {
  DEFAULT_PREVIEW_MODEL,
  type PreviewModel,
} from "@agentonic/contracts/preview-models"
import {
  runtimeMessage,
  toolName,
  turnAnswer,
  turnCeilings,
  type BrokerReply,
  type ModelRequest,
  type ProviderItem,
  type ToolRequest,
  type TurnAnswer,
  type TurnSpec,
} from "@agentonic/contracts/runtime-protocol"
import { GoogleError, type GoogleConfig } from "@agentonic/connectors/google"
import { executeGmail } from "./gmail"
import { executeWeb } from "./web"
import { PreviewFailure } from "./failure"
import {
  previewCost,
  previewModelProfile,
  previewReservation,
} from "./preview-models"
import type { Execute, Lease } from "./pipeline"

// Fixed outcomes the broker records itself: they describe platform state
// (spend limits, pending confirmations), so no runtime can reword them.
export const BUDGET_STOP_ANSWER =
  "La búsqueda alcanzó el presupuesto disponible antes de completar la respuesta. No pude terminar la verificación de todos tus criterios. La búsqueda se ha detenido; no continuará en segundo plano."
export const PROPOSAL_ANSWER =
  "He preparado una acción de Gmail. Revisa la cuenta, los destinatarios y el contenido en la tarjeta de confirmación. Todavía no se ha realizado ningún cambio."

type Options = {
  job: Lease
  execute: Execute
  key: string
  signal: AbortSignal
  turn: TurnSpec
  gmail?: { grant: z.infer<typeof gmailGrant>; config: GoogleConfig }
  webKey?: string
  passageIds: string[]
}
export type Operation =
  | { kind: "gmail"; operation: keyof typeof gmailArguments }
  | { kind: "web"; operation: WebOperation }
type StoredItem = { item: Record<string, unknown>; view: ProviderItem }

const mismatch = () => new Error("runtime_mismatch")
/** Argument schemas always come from the shared contracts, never the child. */
export const toolParameters = (op: Operation) =>
  z.toJSONSchema(
    op.kind === "gmail"
      ? gmailArguments[op.operation]
      : webArguments[op.operation]
  )

/**
 * Broker side of protocol 2. The runtime decides what to ask; this class
 * decides whether it may happen: pinned model controls, offered tools limited
 * to live grants, argument schemas from the shared contracts, tool calls only
 * as returned by the model, per-turn ceilings, reservations before every paid
 * call and the answer invariants. It never trusts the child for authority.
 */
export class TurnBroker {
  answer?: TurnAnswer & { model: PreviewModel }
  private items = new Map<string, StoredItem>()
  private calls = new Map<string, { name: string; arguments: string }>()
  private latestCalls = new Set<string>()
  private executed = new Set<string>()
  private offered = new Set<string>()
  private modelCalls = 0
  private toolCalls = 0
  private gmailCalls = 0
  private unknownOutcome: "research" | "final" | undefined
  private usedToolEvidence = false
  private webSources = new Set<string>()

  constructor(private o: Options) {}

  /** Handles one runtime message; no reply means the turn is complete. */
  async handle(raw: unknown): Promise<BrokerReply | undefined> {
    if (this.answer) throw mismatch()
    const parsed = runtimeMessage.safeParse(raw)
    if (!parsed.success) throw mismatch()
    const message = parsed.data
    if (message.type === "model") return this.model(message)
    if (message.type === "tool") return this.tool(message)
    if (message.type === "result") {
      await this.result(message.result)
      return undefined
    }
    if (
      message.code === "answer_json_invalid" ||
      message.code === "answer_schema_invalid" ||
      message.code === "answer_citations_invalid"
    )
      throw new PreviewFailure(message.code)
    if (message.code === "provider_unavailable" && this.unknownOutcome)
      throw new Error("provider_unavailable")
    throw mismatch()
  }

  private operation(name: string): Operation | undefined {
    const gmail = this.o.turn.tools.gmail.find((op) => toolName(op) === name)
    if (gmail && this.o.gmail?.grant.operations.includes(gmail))
      return { kind: "gmail", operation: gmail }
    const web = this.o.turn.tools.web
      ? (Object.keys(webArguments) as WebOperation[]).find(
          (op) => toolName(op) === name
        )
      : undefined
    return web && this.o.webKey ? { kind: "web", operation: web } : undefined
  }

  private async model(request: ModelRequest): Promise<BrokerReply | undefined> {
    const { job, execute, signal, turn } = this.o
    if (++this.modelCalls > turn.limits.modelCalls) throw mismatch()
    // After an unknown provider outcome only a final answer from a research
    // phase may follow. A paid request is never replayed.
    if (
      this.unknownOutcome === "final" ||
      (this.unknownOutcome === "research" && request.toolChoice !== "none")
    )
      throw mismatch()
    const names = new Set<string>()
    const tools = request.tools.map((offer) => {
      const op = this.operation(offer.name)
      if (!op || names.has(offer.name)) throw mismatch()
      names.add(offer.name)
      return {
        type: "function",
        name: offer.name,
        description: offer.description,
        parameters: toolParameters(op),
        strict: true,
      }
    })
    if (request.toolChoice === "auto" && tools.length === 0) throw mismatch()
    const input = request.input.map((entry) => {
      if (!("type" in entry)) return entry
      if (entry.type === "provider") {
        const stored = this.items.get(entry.ref)
        if (!stored) throw mismatch()
        return stored.item
      }
      if (!this.calls.has(entry.call_id)) throw mismatch()
      return entry
    })
    const model = turn.model as PreviewModel
    const profile = previewModelProfile(model, turn.reasoning)
    const body = JSON.stringify({
      model,
      store: false,
      input,
      text: { format: request.format },
      ...(model === DEFAULT_PREVIEW_MODEL
        ? { temperature: 0, max_output_tokens: 1000 }
        : {
            reasoning: { effort: turn.reasoning },
            max_output_tokens: profile.maxOutput,
            include: ["reasoning.encrypted_content"],
          }),
      ...(tools.length
        ? {
            tools,
            parallel_tool_calls: false,
            tool_choice: request.toolChoice,
          }
        : {}),
    })
    if (Buffer.byteLength(body) > turnCeilings.requestBytes) throw mismatch()
    const id = randomUUID()
    const reserved = await execute("reserve", job, {
      id,
      provider: "openai",
      model,
      microusd: previewReservation(model, body, turn.reasoning),
    })
    if (!reserved.ok) {
      if (!this.o.webKey) throw new Error("budget_exhausted")
      await execute("web-check", job)
      await this.finish({
        text: BUDGET_STOP_ANSWER,
        citations: [],
        insufficientEvidence: true,
      })
      return undefined
    }
    await execute("heartbeat", job)
    let response: Response
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.o.key}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(
            Math.min(
              request.timeoutMs ?? turnCeilings.modelTimeoutMs,
              turnCeilings.modelTimeoutMs
            )
          ),
        ]),
      })
    } catch {
      if (signal.aborted) throw new Error("lease_lost")
      if (this.unknownOutcome || request.toolChoice === "none")
        throw new Error("provider_unavailable")
      this.unknownOutcome = "research"
      return {
        type: "model",
        id: request.id,
        ok: false,
        code: "provider_unavailable",
      }
    }
    if (!response.ok) throw new Error("provider_unavailable")
    const output = (await response.json()) as {
      status?: string
      usage?: { input_tokens: number; output_tokens: number }
      output?: Record<string, unknown>[]
    }
    const usage = output.usage
    if (
      !usage ||
      !Number.isSafeInteger(usage.input_tokens) ||
      !Number.isSafeInteger(usage.output_tokens) ||
      usage.input_tokens < 0 ||
      usage.output_tokens < 0
    )
      throw new Error("provider_unavailable")
    await execute("settle", job, {
      id,
      tokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      microusd: previewCost(model, usage.input_tokens, usage.output_tokens),
    })
    if (output.status !== "completed")
      throw new PreviewFailure("response_incomplete")
    if (this.unknownOutcome) this.unknownOutcome = "final"
    this.offered = names
    this.latestCalls = new Set()
    const items: { ref: string; item: ProviderItem }[] = []
    for (const item of output.output ?? []) {
      const view = this.view(item)
      if (!view) continue
      const ref = `r${this.items.size + 1}`
      this.items.set(ref, { item, view })
      items.push({ ref, item: view })
    }
    const calls = items.filter((x) => x.item.type === "function_call")
    if (calls.length > 1 || (calls.length && request.toolChoice === "none"))
      throw mismatch()
    return { type: "model", id: request.id, ok: true, items }
  }

  private view(item: Record<string, unknown>): ProviderItem | undefined {
    if (item.type === "reasoning") return { type: "reasoning" }
    if (item.type === "message")
      return {
        type: "message",
        text: z
          .array(z.object({ type: z.string(), text: z.string().optional() }))
          .catch([])
          .parse(item.content)
          .filter((c) => c.type === "output_text")
          .map((c) => c.text ?? "")
          .join(""),
      }
    if (item.type !== "function_call") return undefined
    if (
      typeof item.name !== "string" ||
      typeof item.call_id !== "string" ||
      !item.call_id ||
      typeof item.arguments !== "string" ||
      item.arguments.length > turnCeilings.argumentsBytes
    )
      throw mismatch()
    this.calls.set(item.call_id, { name: item.name, arguments: item.arguments })
    this.latestCalls.add(item.call_id)
    return {
      type: "function_call",
      name: item.name,
      callId: item.call_id,
      arguments: item.arguments,
    }
  }

  private async tool(request: ToolRequest): Promise<BrokerReply | undefined> {
    const { job, execute, signal, turn } = this.o
    // Only a call the model just returned, for a tool offered in that same
    // request, executes, and only once.
    const call = this.calls.get(request.callId)
    if (
      !call ||
      !this.latestCalls.has(request.callId) ||
      this.executed.has(request.callId) ||
      !this.offered.has(call.name)
    )
      throw mismatch()
    this.executed.add(request.callId)
    const op = this.operation(call.name)
    if (!op || ++this.toolCalls > turn.limits.toolCalls) throw mismatch()
    let args: unknown
    try {
      args = JSON.parse(call.arguments)
    } catch {
      throw mismatch()
    }
    if (op.kind === "web") {
      const result = await executeWeb(
        op.operation,
        args,
        job,
        execute,
        this.o.webKey!,
        signal,
        Math.min(
          request.timeoutMs ?? turnCeilings.toolTimeoutMs,
          turnCeilings.toolTimeoutMs
        )
      )
      if (typeof result.url === "string" && typeof result.text === "string")
        this.webSources.add(result.url)
      if (result.ok !== false) this.usedToolEvidence = true
      return { type: "tool", id: request.id, output: result }
    }
    if (++this.gmailCalls > turn.limits.gmailCalls) throw mismatch()
    const result = await executeGmail(
      op.operation,
      args,
      this.o.gmail!.grant,
      job,
      execute,
      this.o.gmail!.config
    )
    if (!gmailReads.some((read) => read === op.operation)) {
      await this.finish({
        text: PROPOSAL_ANSWER,
        citations: [],
        insufficientEvidence: true,
      })
      return undefined
    }
    this.usedToolEvidence = true
    return { type: "tool", id: request.id, output: result }
  }

  private async result(raw: unknown) {
    const parsed = turnAnswer.safeParse(raw)
    if (!parsed.success) throw new PreviewFailure("answer_schema_invalid")
    const answer = parsed.data
    if (answer.citations.some((id) => !this.o.passageIds.includes(id)))
      throw new PreviewFailure("answer_citations_invalid")
    // insufficientEvidence measures knowledge-base coverage only.
    if (this.usedToolEvidence && answer.citations.length === 0)
      answer.insufficientEvidence = true
    if (!answer.insufficientEvidence && answer.citations.length === 0)
      throw new PreviewFailure("answer_citations_invalid")
    // Source links come from reads the broker performed, not from the model.
    if (this.webSources.size) {
      const sources =
        "\n\nFuentes web:\n" +
        [...this.webSources].map((url) => "• " + url).join("\n")
      answer.text = answer.text.slice(0, 12000 - sources.length) + sources
    }
    await this.finish(answer)
  }

  private async finish(answer: TurnAnswer) {
    const recorded = { ...answer, model: this.o.turn.model as PreviewModel }
    await this.o.execute("answer", this.o.job, recorded)
    this.answer = recorded
  }
}

export function brokerFailure(error: unknown) {
  return error instanceof PreviewFailure
    ? error
    : error instanceof GoogleError
      ? "provider_unavailable"
      : error instanceof Error &&
          [
            "budget_exhausted",
            "configuration_required",
            "provider_unavailable",
            "lease_lost",
          ].includes(error.message)
        ? error.message
        : "runtime_mismatch"
}

/** Runs one protocol-2 turn in a credential-free child process. */
export function runBrokeredTurn(
  entry: string,
  start: { envelope: Record<string, unknown>; turn: TurnSpec },
  broker: TurnBroker,
  signal: AbortSignal,
  timeoutMs: number
) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = fork(entry, [], {
      execArgv: ["--max-old-space-size=192"],
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })
    let finished = false
    let queue = Promise.resolve()
    const finish = (error?: string | PreviewFailure) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      child.kill("SIGKILL")
      if (error)
        reject(error instanceof PreviewFailure ? error : new Error(error))
      else resolvePromise()
    }
    const abort = () => finish("lease_lost")
    const timer = setTimeout(() => finish("provider_unavailable"), timeoutMs)
    signal.addEventListener("abort", abort, { once: true })
    child.on("error", () => finish("runtime_mismatch"))
    // A runtime that reports an error and exits keeps its reported code:
    // the exit is handled after any message already received.
    child.on("exit", () => {
      queue = queue.then(() => finish("runtime_mismatch"))
    })
    // Messages are handled strictly in order; the runtime waits for each reply.
    child.on("message", (message: unknown) => {
      queue = queue
        .then(async () => {
          if (finished) return
          const reply = await broker.handle(message)
          if (finished) return
          if (broker.answer) finish()
          else if (reply) child.send(reply)
          else finish("runtime_mismatch")
        })
        .catch((error) => finish(brokerFailure(error)))
    })
    if (signal.aborted) {
      abort()
      return
    }
    child.send({ type: "start", ...start })
  })
}
