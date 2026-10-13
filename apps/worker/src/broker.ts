import { fork } from "node:child_process"
import { z } from "zod"
import {
  gmailArguments,
  gmailGrantFor,
  gmailReads,
  offeredGmailArguments,
} from "@agentonic/contracts/gmail"
import type { gmailGrant } from "@agentonic/contracts/gmail"
import {
  driveArguments,
  driveReads,
  type DriveGrant,
  type DriveOperation,
} from "@agentonic/contracts/drive"
import { webArguments, type WebOperation } from "@agentonic/contracts/web"
import type { PreviewModel } from "@agentonic/contracts/preview-models"
import {
  batchCeilings,
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
import { GoogleError } from "@agentonic/connectors/google"
import { PreviewFailure, TurnFailure } from "./failure"
import type { Execute, Lease } from "./pipeline"
import type { Providers } from "./providers"

// Fixed outcomes the broker records itself: they describe platform state
// (spend limits, pending confirmations), so no runtime can reword them.
export const BUDGET_STOP_ANSWER =
  "La búsqueda alcanzó el presupuesto disponible antes de completar la respuesta. No pude terminar la verificación de todos tus criterios. La búsqueda se ha detenido; no continuará en segundo plano."
export const PROPOSAL_ANSWER =
  "He preparado una acción de Gmail. Revisa la cuenta, los destinatarios y el contenido en la tarjeta de confirmación. Todavía no se ha realizado ningún cambio."
/** A write the run's schedule pre-authorized (§58): the platform executes it. */
export const SCHEDULED_ACTION_ANSWER =
  "He preparado una acción de Gmail que esta programación autorizó. Se ejecutará automáticamente; su resultado aparecerá en la tarjeta de la acción."
export const DRIVE_PROPOSAL_ANSWER =
  "He preparado un cambio en Google Drive. Revisa la cuenta, el documento y el contenido en la tarjeta de confirmación. Todavía no se ha realizado ningún cambio."
export const DRIVE_SCHEDULED_ANSWER =
  "He preparado un cambio en Google Drive que esta programación autorizó. Se ejecutará automáticamente; su resultado aparecerá en la tarjeta de la acción."
/**
 * Appended to a mailbox-batch answer whose turn proposed changes (§67): the
 * platform, not the model, says what awaits confirmation.
 */
export const pendingNotice = (count: number) =>
  count === 1
    ? "He preparado 1 acción que espera tu confirmación en su tarjeta de esta conversación. Todavía no se ha realizado ningún cambio."
    : `He preparado ${count} acciones que esperan tu confirmación en sus tarjetas de esta conversación. Todavía no se ha realizado ningún cambio.`
export const proposalAnswer = (
  result: unknown,
  provider: "gmail" | "drive" = "gmail"
) =>
  (result as { automatic?: unknown } | null)?.automatic === true
    ? provider === "drive"
      ? DRIVE_SCHEDULED_ANSWER
      : SCHEDULED_ACTION_ANSWER
    : provider === "drive"
      ? DRIVE_PROPOSAL_ANSWER
      : PROPOSAL_ANSWER

type Options = {
  job: Lease
  execute: Execute
  /** Every paid or credentialed call; an agent copy's go through its gateway. */
  providers: Providers
  signal: AbortSignal
  turn: TurnSpec
  /** The live Gmail grant offered this turn, if any. */
  gmail?: z.infer<typeof gmailGrant>
  /** The live Drive grant offered this turn, if any (runtimes with driveContract). */
  drive?: DriveGrant
  /** Public web tools are offered this turn. */
  web: boolean
  passageIds: string[]
  /** The runtime declares mailboxBatch (§67): the turn spec carries its limits. */
  batch?: boolean
  /** A chat or preview of a batch runtime shows its answer as it is written (§68). */
  stream?: boolean
}
export type Operation =
  | { kind: "gmail"; operation: keyof typeof gmailArguments }
  | { kind: "drive"; operation: DriveOperation }
  | { kind: "web"; operation: WebOperation }
type StoredItem = { item: Record<string, unknown>; view: ProviderItem }

/** A protocol violation, named for the log (§67); the turn shows runtime_mismatch. */
const mismatch = (diagnostic: string) =>
  new TurnFailure("runtime_mismatch", diagnostic)
const MESSAGE_FIELDS = new Set([
  "type",
  "id",
  "input",
  "tools",
  "toolChoice",
  "format",
  "timeoutMs",
  "callId",
  "result",
  "code",
])
/** Names the field a refused runtime message broke, never its content (§72). */
function messageInvalid(error: { issues: { path: PropertyKey[] }[] }) {
  const field = error.issues[0]?.path[0]
  return typeof field === "string" && MESSAGE_FIELDS.has(field)
    ? `message_invalid_${field.toLowerCase()}`
    : "message_invalid"
}
/** Argument schemas always come from the shared contracts, never the child. */
export const toolParameters = (op: Operation, batch = false) =>
  z.toJSONSchema(
    op.kind === "gmail"
      ? offeredGmailArguments(op.operation, batch)
      : op.kind === "drive"
        ? driveArguments[op.operation]
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
  private gmailWrites = 0
  private driveCalls = 0
  /** Proposals this turn left for the owner's confirmation (batch turns). */
  proposals = 0
  private unknownOutcome: "research" | "final" | undefined
  private usedToolEvidence = false
  private webSources = new Set<string>()

  constructor(private o: Options) {}

  /** Handles one runtime message; no reply means the turn is complete. */
  async handle(raw: unknown): Promise<BrokerReply | undefined> {
    if (this.answer) throw mismatch("after_answer")
    const parsed = runtimeMessage.safeParse(raw)
    if (!parsed.success) throw mismatch(messageInvalid(parsed.error))
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
      throw new TurnFailure("provider_unavailable", "provider_uncertain")
    throw mismatch(`runtime_${message.code}`)
  }

  private operation(name: string): Operation | undefined {
    const gmail = this.o.turn.tools.gmail.find((op) => toolName(op) === name)
    // A thread read needs the live read grant (§68).
    if (
      gmail &&
      this.o.gmail?.operations.some((op) => op === gmailGrantFor(gmail))
    )
      return { kind: "gmail", operation: gmail }
    const drive = this.o.turn.tools.drive?.find((op) => toolName(op) === name)
    if (drive && this.o.drive?.operations.includes(drive))
      return { kind: "drive", operation: drive }
    const web = this.o.turn.tools.web
      ? (Object.keys(webArguments) as WebOperation[]).find(
          (op) => toolName(op) === name
        )
      : undefined
    return web && this.o.web ? { kind: "web", operation: web } : undefined
  }

  private async model(request: ModelRequest): Promise<BrokerReply | undefined> {
    const { job, execute, signal, turn, batch } = this.o
    if (++this.modelCalls > turn.limits.modelCalls)
      throw mismatch("model_calls")
    // After an unknown provider outcome only a final answer from a research
    // phase may follow. A paid request is never replayed.
    if (
      this.unknownOutcome === "final" ||
      (this.unknownOutcome === "research" && request.toolChoice !== "none")
    )
      throw mismatch("after_uncertain")
    const names = new Set<string>()
    const tools = request.tools.map((offer) => {
      const op = this.operation(offer.name)
      if (!op || names.has(offer.name)) throw mismatch("tool_not_granted")
      names.add(offer.name)
      return {
        type: "function",
        name: offer.name,
        description: offer.description,
        parameters: toolParameters(op, batch),
        strict: true,
      }
    })
    if (request.toolChoice === "auto" && tools.length === 0)
      throw mismatch("no_tools")
    const input = request.input.map((entry) => {
      if (!("type" in entry)) return entry
      if (entry.type === "provider") {
        const stored = this.items.get(entry.ref)
        if (!stored) throw mismatch("unknown_item")
        return stored.item
      }
      if (!this.calls.has(entry.call_id)) throw mismatch("unknown_call")
      return entry
    })
    const final = request.toolChoice === "none"
    const outcome = await this.o.providers.respond(
      {
        model: turn.model as PreviewModel,
        reasoning: turn.reasoning,
        input,
        format: request.format,
        tools,
        toolChoice: request.toolChoice,
        // Batch turns: several calls per response, and room for the answer in
        // any call, since the model may answer without a forced final call.
        ...(batch
          ? {
              parallelToolCalls: !final && tools.length > 0,
              maxOutputTokens: batchCeilings.finalOutputTokens,
              ...(this.o.stream ? { stream: true } : {}),
            }
          : {}),
        timeoutMs: Math.min(
          request.timeoutMs ?? turnCeilings.modelTimeoutMs,
          batch ? batchCeilings.modelTimeoutMs : turnCeilings.modelTimeoutMs
        ),
      },
      job,
      execute,
      signal
    )
    if (outcome.kind === "budget") {
      if (!this.o.web) throw new Error("budget_exhausted")
      await execute("web-check", job)
      await this.finish({
        text: BUDGET_STOP_ANSWER,
        citations: [],
        insufficientEvidence: true,
      })
      return undefined
    }
    if (outcome.kind === "uncertain") {
      if (this.unknownOutcome || request.toolChoice === "none")
        throw new TurnFailure("provider_unavailable", "provider_uncertain")
      this.unknownOutcome = "research"
      return {
        type: "model",
        id: request.id,
        ok: false,
        code: "provider_unavailable",
      }
    }
    const output = outcome
    if (output.status !== "completed")
      throw new PreviewFailure("response_incomplete")
    if (this.unknownOutcome) this.unknownOutcome = "final"
    this.offered = names
    this.latestCalls = new Set()
    const items: { ref: string; item: ProviderItem }[] = []
    for (const item of output.output) {
      const view = this.view(item)
      if (!view) continue
      const ref = `r${this.items.size + 1}`
      this.items.set(ref, { item, view })
      items.push({ ref, item: view })
    }
    const calls = items.filter((x) => x.item.type === "function_call")
    if (calls.length && request.toolChoice === "none")
      throw mismatch("call_after_final")
    if (calls.length > (batch ? (turn.limits.callsPerResponse ?? 1) : 1))
      throw mismatch("calls_per_response")
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
      throw mismatch("call_invalid")
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
      throw mismatch("call_not_offered")
    this.executed.add(request.callId)
    const op = this.operation(call.name)
    if (!op) throw mismatch("call_not_offered")
    if (++this.toolCalls > turn.limits.toolCalls) throw mismatch("tool_calls")
    let args: unknown
    try {
      args = JSON.parse(call.arguments)
    } catch {
      throw mismatch("arguments_json")
    }
    if (op.kind === "web") {
      const result = await this.o.providers.webTool(
        op.operation,
        args,
        job,
        execute,
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
    if (op.kind === "drive") {
      if (++this.driveCalls > (turn.limits.driveCalls ?? 0))
        throw mismatch("drive_calls")
      const result = await this.o.providers.driveTool(
        op.operation,
        args,
        this.o.drive!,
        job,
        execute,
        signal
      )
      // A proposal ends the turn, except in batch turns, where it returns to
      // the model; a refused write (an unknown file) goes back like a read.
      if (
        !driveReads.some((read) => read === op.operation) &&
        (result as { pendingApproval?: unknown } | null)?.pendingApproval ===
          true
      ) {
        if (this.continues(result)) {
          this.proposals++
          return { type: "tool", id: request.id, output: result }
        }
        await this.finish({
          text: proposalAnswer(result, "drive"),
          citations: [],
          insufficientEvidence: true,
        })
        return undefined
      }
      this.usedToolEvidence = true
      return { type: "tool", id: request.id, output: result }
    }
    const read = gmailReads.some((r) => r === op.operation)
    // Batch turns count reads and proposals apart; earlier runtimes share three.
    if (
      this.o.batch
        ? read
          ? ++this.gmailCalls > (turn.limits.gmailReads ?? 0)
          : ++this.gmailWrites > (turn.limits.gmailWrites ?? 0)
        : ++this.gmailCalls > turn.limits.gmailCalls
    )
      throw mismatch("gmail_calls")
    const result = await this.o.providers.gmailTool(
      op.operation,
      args,
      this.o.gmail!,
      job,
      execute,
      { batch: this.o.batch === true }
    )
    if (!read) {
      if (this.continues(result)) {
        this.proposals++
        return { type: "tool", id: request.id, output: result }
      }
      await this.finish({
        text: proposalAnswer(result),
        citations: [],
        insufficientEvidence: true,
      })
      return undefined
    }
    this.usedToolEvidence = true
    return { type: "tool", id: request.id, output: result }
  }

  /** A batch turn's proposal goes back to the model; a scheduled run's pre-authorized one still ends it. */
  private continues(result: unknown) {
    return (
      this.o.batch === true &&
      (result as { automatic?: unknown } | null)?.automatic !== true
    )
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
    // Source links come from reads the broker performed, not from the model,
    // and so does the count of changes awaiting confirmation.
    const max = this.o.batch ? batchCeilings.answerChars : 12000
    const sources = this.webSources.size
      ? "\n\nFuentes web:\n" +
        [...this.webSources].map((url) => "• " + url).join("\n")
      : ""
    const notice = this.proposals ? "\n\n" + pendingNotice(this.proposals) : ""
    if (sources || notice)
      answer.text =
        answer.text.slice(0, max - sources.length - notice.length) +
        sources +
        notice
    await this.finish(answer)
  }

  /**
   * A batch turn that proposed changes but could not finish its answer still
   * says so, instead of failing with cards left behind it (§67).
   */
  async recordProposals() {
    if (this.answer || !this.proposals) return false
    await this.finish({
      text: pendingNotice(this.proposals),
      citations: [],
      insufficientEvidence: true,
    })
    return true
  }

  private async finish(answer: TurnAnswer) {
    const recorded = { ...answer, model: this.o.turn.model as PreviewModel }
    try {
      await this.o.execute("answer", this.o.job, recorded)
    } catch (error) {
      throw databaseFailure(error, "answer_refused")
    }
    this.answer = recorded
  }
}

/** A database refusal (42501) or error, named without its message. */
function databaseFailure(error: unknown, refused: string) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : ""
  return code === "42501"
    ? new TurnFailure("runtime_mismatch", refused)
    : /^[0-9A-Z]{5}$/.test(code)
      ? new TurnFailure("runtime_mismatch", `database_${code.toLowerCase()}`)
      : error
}

/** The code a turn records and the diagnostic its log line carries. */
export function brokerFailure(error: unknown): PreviewFailure | TurnFailure {
  if (error instanceof PreviewFailure || error instanceof TurnFailure)
    return error
  if (error instanceof GoogleError)
    return new TurnFailure("provider_unavailable", `google_${error.code}`)
  if (
    error instanceof Error &&
    [
      "budget_exhausted",
      "configuration_required",
      "provider_unavailable",
      "lease_lost",
    ].includes(error.message)
  )
    return new TurnFailure(error.message, error.message)
  const named = databaseFailure(error, "database_refused")
  return named instanceof TurnFailure
    ? named
    : new TurnFailure("runtime_mismatch", "unexpected")
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
    const finish = (error?: PreviewFailure | TurnFailure) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      child.kill("SIGKILL")
      if (error) reject(error)
      else resolvePromise()
    }
    const abort = () => finish(new TurnFailure("lease_lost", "lease_lost"))
    const timer = setTimeout(
      () => finish(new TurnFailure("provider_unavailable", "turn_deadline")),
      timeoutMs
    )
    signal.addEventListener("abort", abort, { once: true })
    child.on("error", () => finish(mismatch("runtime_spawn")))
    // A runtime that reports an error and exits keeps its reported code:
    // the exit is handled after any message already received.
    child.on("exit", () => {
      queue = queue.then(() => finish(mismatch("runtime_exit")))
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
          else finish(mismatch("no_answer"))
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
