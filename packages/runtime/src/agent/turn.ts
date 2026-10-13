import { z } from "zod"
import {
  startMessage,
  turnAnswer,
  type InputItem,
  type ModelReply,
  type ModelRequest,
  type ToolReply,
  type ToolRequest,
  type TurnAnswer,
  type TurnSpec,
} from "@agentonic/contracts/runtime-protocol"
import { RuntimeError, expired, readEnvelope } from "./envelope"
import {
  FINAL_ANSWER_NOTE,
  MAILBOX_BATCH_POLICY,
  TOOLS_DONE_NOTE,
  WEB_RESEARCH_POLICY,
  WEB_WHEN_NEEDED,
  actionsNote,
  instructions,
  remainingCallsNote,
  styleGuideNote,
} from "./instructions"
import { toolOffers } from "../tools/registry"
import { gmailReads } from "@agentonic/contracts/gmail"
import { driveReads } from "@agentonic/contracts/drive"

/** Bounded research allowance; the broker may supply a lower ceiling. */
export const RESEARCH_CALLS = 8
export const RESEARCH_MS = 65_000
export const MAILBOX_CALLS = 3
export const DRIVE_CALLS = 3
const DEFAULT_TOOL_CALLS = 3
// Mailbox batch turns (§67): new tool calls until 105 s, and everything done
// by 230 s, inside the broker's 240 s deadline. Any model call may write the
// final answer, so each may take up to 120 s of what is left.
export const BATCH_TOOLS_MS = 105_000
export const BATCH_TURN_MS = 230_000
export const BATCH_CALL_MS = 120_000

export type Broker = {
  model(request: Omit<ModelRequest, "type" | "id">): Promise<ModelReply>
  tool(request: Omit<ToolRequest, "type" | "id">): Promise<ToolReply>
}

const baseFormat = {
  type: "json_schema" as const,
  name: "agent_preview_answer",
  strict: true as const,
  schema: {
    type: "object",
    properties: {
      text: { type: "string" },
      citations: { type: "array", items: { type: "string" } },
      insufficientEvidence: { type: "boolean" },
    },
    required: ["text", "citations", "insufficientEvidence"],
    additionalProperties: false,
  },
}
// Constrain citations to the supplied knowledge-base passages. Gmail IDs and
// website URLs are never passage citations.
function answerFormat(passageIds: string[]) {
  return {
    ...baseFormat,
    schema: {
      ...baseFormat.schema,
      properties: {
        ...baseFormat.schema.properties,
        citations: {
          type: "array",
          description:
            "Only IDs of supplied knowledge-base passages. Gmail IDs, Drive file IDs and website URLs are never KB citations. Use an empty array for tool-only answers.",
          items: passageIds.length
            ? { type: "string", enum: passageIds }
            : { type: "string" },
          maxItems: passageIds.length ? 8 : 0,
        },
        insufficientEvidence: passageIds.length
          ? baseFormat.schema.properties.insufficientEvidence
          : {
              type: "boolean",
              enum: [true],
              description:
                "No knowledge-base passages are available. This flag measures knowledge-base evidence only, not web, Gmail or Drive access.",
            },
      },
    },
  }
}

function readAnswer(text: string, passageIds: string[]): TurnAnswer {
  let answer: TurnAnswer
  try {
    answer = turnAnswer.parse(JSON.parse(text))
  } catch (error) {
    throw new RuntimeError(
      error instanceof SyntaxError
        ? "answer_json_invalid"
        : error instanceof z.ZodError &&
            error.issues.some((i) => i.path[0] === "citations")
          ? "answer_citations_invalid"
          : "answer_schema_invalid"
    )
  }
  if (answer.citations.some((id) => !passageIds.includes(id)))
    throw new RuntimeError("answer_citations_invalid")
  return answer
}

function canonicalArguments(text: string) {
  try {
    return JSON.stringify(JSON.parse(text))
  } catch {
    return text
  }
}

/**
 * One private staging turn: verify the frozen candidate, then run the bounded
 * tool loop. Every model and tool call goes through the broker, which owns
 * credentials, spending, live authorization and the recorded answer.
 */
export async function runAgentTurn(
  start: unknown,
  broker: Broker
): Promise<TurnAnswer> {
  const parsed = startMessage.safeParse(start)
  if (!parsed.success) throw new RuntimeError("runtime_failed")
  const { turn } = parsed.data
  const { envelope, configuration, skills, access } = readEnvelope(
    parsed.data.envelope
  )
  const passageIds = envelope.passages.map((p) => p.id)
  const input: InputItem[] = [
    { role: "system", content: instructions },
    { role: "developer", content: configuration.systemPrompt },
    {
      role: "user",
      content: `Selected reference skills (not authorization): ${JSON.stringify(skills)}`,
    },
    ...(envelope.styleGuide
      ? [
          {
            role: "user" as const,
            content: styleGuideNote(envelope.styleGuide),
          },
        ]
      : []),
    ...envelope.history.flatMap((t) => [
      { role: "user" as const, content: t.query },
      { role: "assistant" as const, content: t.answer },
      ...(t.actions?.length
        ? [{ role: "system" as const, content: actionsNote(t.actions) }]
        : []),
    ]),
    {
      role: "user",
      content: JSON.stringify({
        question: envelope.query,
        knowledgeEnabled: access.collectionIds.length > 0,
        passages: envelope.passages,
      }),
    },
  ]
  const web = turn.tools.web
  const offers = toolOffers(turn.tools)
  const format = answerFormat(passageIds)
  if (turn.limits.gmailReads !== undefined)
    return batchTurn(
      input,
      turn,
      offers,
      broker,
      format,
      passageIds,
      envelope.expiresAt
    )
  if (web) input.push({ role: "system", content: WEB_RESEARCH_POLICY })
  const maxCalls = Math.min(
    web ? RESEARCH_CALLS : DEFAULT_TOOL_CALLS,
    turn.limits.toolCalls,
    turn.limits.modelCalls - 1
  )
  const researchDeadline = Date.now() + RESEARCH_MS
  const mailboxLimit = Math.min(MAILBOX_CALLS, turn.limits.gmailCalls)
  const driveLimit = Math.min(DRIVE_CALLS, turn.limits.driveCalls ?? 0)
  const failedRequests = new Set<string>()
  let stopTools = false,
    mailboxCalls = 0,
    driveCalls = 0,
    usedToolEvidence = false

  for (let step = 0; step <= maxCalls; step++) {
    const offered = offers.filter(
      (o) =>
        (!o.name.startsWith("gmail_") || mailboxCalls < mailboxLimit) &&
        (!o.name.startsWith("drive_") || driveCalls < driveLimit)
    )
    const finalOnly =
      stopTools ||
      step === maxCalls ||
      offered.length === 0 ||
      (web && Date.now() >= researchDeadline)
    if (web)
      input.push({
        role: "system",
        content: finalOnly
          ? FINAL_ANSWER_NOTE
          : remainingCallsNote(maxCalls - step),
      })
    const reply = await broker.model({
      input: [...input],
      tools: offered,
      toolChoice: finalOnly ? "none" : "auto",
      format,
      timeoutMs:
        web && !finalOnly
          ? Math.max(1, Math.min(45000, researchDeadline - Date.now()))
          : web
            ? 35000
            : 45000,
    })
    if (!reply.ok) {
      // An interrupted research request is not replayed; its reservation
      // stays with the broker. Answer from the evidence already collected.
      if (web && !finalOnly && Date.now() >= researchDeadline) {
        stopTools = true
        continue
      }
      throw new RuntimeError("provider_unavailable")
    }
    const calls = reply.items.filter((x) => x.item.type === "function_call")
    if (calls.length) {
      if (calls.length !== 1 || finalOnly)
        throw new RuntimeError("runtime_failed")
      // Reasoning models need their returned reasoning items to continue a
      // tool call. The broker substitutes them; their content never leaves it.
      for (const x of reply.items)
        if (x.item.type === "reasoning")
          input.push({ type: "provider", ref: x.ref })
      const call = calls[0]!
      if (call.item.type !== "function_call")
        throw new RuntimeError("runtime_failed")
      const { name, callId } = call.item
      input.push({ type: "provider", ref: call.ref })
      let output: unknown
      if (name.startsWith("web_") && web) {
        const key = name + canonicalArguments(call.item.arguments)
        const result = failedRequests.has(key)
          ? { ok: false, error: "already_failed", untrusted: true }
          : Date.now() >= researchDeadline
            ? { ok: false, error: "time_limit", stop: true, untrusted: true }
            : ((
                await broker.tool({
                  callId,
                  timeoutMs: Math.max(
                    1,
                    Math.min(20000, researchDeadline - Date.now())
                  ),
                })
              ).output as Record<string, unknown>)
        if (result.ok === false) failedRequests.add(key)
        else usedToolEvidence = true
        if (result.stop === true) stopTools = true
        output = result
      } else if (name.startsWith("gmail_")) {
        if (++mailboxCalls > mailboxLimit)
          throw new RuntimeError("runtime_failed")
        output = (await broker.tool({ callId })).output
        usedToolEvidence = true
      } else if (name.startsWith("drive_")) {
        if (++driveCalls > driveLimit) throw new RuntimeError("runtime_failed")
        output = (await broker.tool({ callId })).output
        usedToolEvidence = true
      } else throw new RuntimeError("runtime_failed")
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: JSON.stringify(output),
      })
      continue
    }
    const answer = readAnswer(
      reply.items
        .map((x) => (x.item.type === "message" ? x.item.text : ""))
        .join(""),
      passageIds
    )
    // The flag describes knowledge-base coverage only. A tool-backed answer
    // without passage citations is therefore marked insufficient.
    if (usedToolEvidence && answer.citations.length === 0)
      answer.insufficientEvidence = true
    if (!answer.insufficientEvidence && answer.citations.length === 0)
      throw new RuntimeError("answer_citations_invalid")
    if (expired(envelope.expiresAt)) throw new RuntimeError("preview_expired")
    return answer
  }
  throw new RuntimeError("runtime_failed")
}

type Kind = "read" | "write" | "web" | "drive"
const kindOf = (name: string): Kind | undefined => {
  const operation = name.replace(/_/g, ".")
  if (name.startsWith("gmail_"))
    return gmailReads.some((r) => r === operation) ? "read" : "write"
  if (name.startsWith("drive_")) return "drive"
  if (name.startsWith("web_")) return "web"
  return undefined
}
/** Gmail and Drive reads are evidence; proposals and web reads are counted apart. */
const evidence = (name: string) =>
  kindOf(name) === "read" ||
  (name.startsWith("drive_") &&
    driveReads.some((r) => r === name.replace(/_/g, ".")))

/**
 * A mailbox batch turn (runtime 0.7.0, §67): Gmail reads, Gmail proposals, web
 * and Drive each have their own allowance; the model may request several calls
 * at once; proposals return to the model instead of ending the turn; and the
 * final answer gets its own time. Web pressure appears only once the model
 * uses the web.
 */
async function batchTurn(
  input: InputItem[],
  turn: TurnSpec,
  offers: ReturnType<typeof toolOffers>,
  broker: Broker,
  format: ReturnType<typeof answerFormat>,
  passageIds: string[],
  expiresAt: string
): Promise<TurnAnswer> {
  const { limits, tools } = turn
  const allowance: Record<Kind, number> = {
    read: limits.gmailReads ?? 0,
    write: limits.gmailWrites ?? 0,
    web: tools.web ? Math.min(RESEARCH_CALLS, limits.toolCalls) : 0,
    drive: Math.min(DRIVE_CALLS, limits.driveCalls ?? 0),
  }
  const used: Record<Kind, number> = { read: 0, write: 0, web: 0, drive: 0 }
  const perResponse = limits.callsPerResponse ?? 1
  if (tools.gmail.length)
    input.push({ role: "system", content: MAILBOX_BATCH_POLICY })
  if (tools.web)
    input.push(
      { role: "system", content: WEB_WHEN_NEEDED },
      { role: "system", content: WEB_RESEARCH_POLICY }
    )
  const deadline = Date.now() + BATCH_TOOLS_MS
  const turnEnd = Date.now() + BATCH_TURN_MS
  const failedRequests = new Set<string>()
  let total = 0,
    stopTools = false,
    webUsed = false,
    usedToolEvidence = false

  for (let step = 0; step < limits.modelCalls; step++) {
    const offered = offers.filter((o) => {
      const kind = kindOf(o.name)
      return kind !== undefined && used[kind] < allowance[kind]
    })
    const finalOnly =
      stopTools ||
      step === limits.modelCalls - 1 ||
      total >= limits.toolCalls ||
      offered.length === 0 ||
      Date.now() >= deadline
    if (finalOnly && total > 0)
      input.push({
        role: "system",
        content: webUsed ? FINAL_ANSWER_NOTE : TOOLS_DONE_NOTE,
      })
    else if (!finalOnly && webUsed)
      input.push({
        role: "system",
        content: remainingCallsNote(allowance.web - used.web),
      })
    const reply = await broker.model({
      input: [...input],
      tools: offered,
      toolChoice: finalOnly ? "none" : "auto",
      format,
      timeoutMs: Math.max(1, Math.min(BATCH_CALL_MS, turnEnd - Date.now())),
    })
    if (!reply.ok) {
      // As in research turns: an interrupted request is never replayed;
      // answer from what was gathered.
      if (!finalOnly && Date.now() >= deadline) {
        stopTools = true
        continue
      }
      throw new RuntimeError("provider_unavailable")
    }
    const calls = reply.items.filter((x) => x.item.type === "function_call")
    if (calls.length) {
      if (finalOnly || calls.length > perResponse)
        throw new RuntimeError("runtime_failed")
      for (const x of reply.items)
        if (x.item.type === "reasoning")
          input.push({ type: "provider", ref: x.ref })
      for (const call of calls) input.push({ type: "provider", ref: call.ref })
      for (const call of calls) {
        if (call.item.type !== "function_call")
          throw new RuntimeError("runtime_failed")
        const { name, callId } = call.item
        const kind = kindOf(name)
        if (!kind || !offered.some((o) => o.name === name))
          throw new RuntimeError("runtime_failed")
        let output: unknown
        if (used[kind] >= allowance[kind] || total >= limits.toolCalls)
          // Asked for in the same response past its allowance: refused here.
          output = { ok: false, error: "allowance_exhausted", untrusted: true }
        else if (kind === "web") {
          used.web++
          total++
          webUsed = true
          const key = name + canonicalArguments(call.item.arguments)
          const result = failedRequests.has(key)
            ? { ok: false, error: "already_failed", untrusted: true }
            : Date.now() >= deadline
              ? { ok: false, error: "time_limit", stop: true, untrusted: true }
              : ((
                  await broker.tool({
                    callId,
                    timeoutMs: Math.max(
                      1,
                      Math.min(20000, deadline - Date.now())
                    ),
                  })
                ).output as Record<string, unknown>)
          if (result.ok === false) failedRequests.add(key)
          else usedToolEvidence = true
          if (result.stop === true) stopTools = true
          output = result
        } else {
          used[kind]++
          total++
          output = (await broker.tool({ callId })).output
          if (evidence(name)) usedToolEvidence = true
        }
        input.push({
          type: "function_call_output",
          call_id: callId,
          output: JSON.stringify(output),
        })
      }
      continue
    }
    const answer = readAnswer(
      reply.items
        .map((x) => (x.item.type === "message" ? x.item.text : ""))
        .join(""),
      passageIds
    )
    if (usedToolEvidence && answer.citations.length === 0)
      answer.insufficientEvidence = true
    if (!answer.insufficientEvidence && answer.citations.length === 0)
      throw new RuntimeError("answer_citations_invalid")
    if (expired(expiresAt)) throw new RuntimeError("preview_expired")
    return answer
  }
  throw new RuntimeError("runtime_failed")
}
