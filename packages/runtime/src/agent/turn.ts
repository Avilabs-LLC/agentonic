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
} from "@agentonic/contracts/runtime-protocol"
import { RuntimeError, expired, readEnvelope } from "./envelope"
import {
  FINAL_ANSWER_NOTE,
  WEB_RESEARCH_POLICY,
  instructions,
  remainingCallsNote,
} from "./instructions"
import { toolOffers } from "../tools/registry"

/** Bounded research allowance; the broker may supply a lower ceiling. */
export const RESEARCH_CALLS = 8
export const RESEARCH_MS = 65_000
export const MAILBOX_CALLS = 3
const DEFAULT_TOOL_CALLS = 3

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
            "Only IDs of supplied knowledge-base passages. Gmail IDs and website URLs are never KB citations. Use an empty array for tool-only answers.",
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
                "No knowledge-base passages are available. This flag measures knowledge-base evidence only, not web or Gmail access.",
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
    ...envelope.history.flatMap((t) => [
      { role: "user" as const, content: t.query },
      { role: "assistant" as const, content: t.answer },
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
  if (web) input.push({ role: "system", content: WEB_RESEARCH_POLICY })
  const offers = toolOffers(turn.tools)
  const format = answerFormat(passageIds)
  const maxCalls = Math.min(
    web ? RESEARCH_CALLS : DEFAULT_TOOL_CALLS,
    turn.limits.toolCalls,
    turn.limits.modelCalls - 1
  )
  const researchDeadline = Date.now() + RESEARCH_MS
  const mailboxLimit = Math.min(MAILBOX_CALLS, turn.limits.gmailCalls)
  const failedRequests = new Set<string>()
  let stopTools = false,
    mailboxCalls = 0,
    usedToolEvidence = false

  for (let step = 0; step <= maxCalls; step++) {
    const offered = offers.filter(
      (o) => !o.name.startsWith("gmail_") || mailboxCalls < mailboxLimit
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
