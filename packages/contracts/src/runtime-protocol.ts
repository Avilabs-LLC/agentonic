import { z } from "zod"
import { gmailToolOperation } from "./gmail"
import { driveOperation } from "./drive"
import { modelId, reasoningLevel } from "./models"

// Broker protocol 2. The frozen runtime artifact runs the agent loop: it
// composes instructions, offers tools, decides when to call them and when to
// answer. The trusted broker holds every credential, pins the model, executes
// only tool calls the model actually returned, meters spend and records the
// answer. Artifacts without `brokerProtocol` use protocol 1 (one generation).
export const BROKER_PROTOCOL = "2"

export const toolName = (operation: string) => operation.replaceAll(".", "_")

/** Ceilings the broker enforces whatever the runtime requests. */
export const turnCeilings = {
  modelCalls: 12,
  toolCalls: 8,
  gmailCalls: 3,
  driveCalls: 3,
  requestBytes: 750_000,
  modelTimeoutMs: 45_000,
  toolTimeoutMs: 20_000,
  argumentsBytes: 30_000,
} as const

/**
 * Mailbox batch turns (architecture §67): runtimes whose manifest declares
 * `mailboxBatch: "1"` (runtime 0.7.0) get Gmail read and write allowances of
 * their own, several tool calls per model response, proposals that don't end
 * the turn, and room for a long final answer. Earlier runtimes keep
 * `turnCeilings` exactly.
 */
export const batchCeilings = {
  modelCalls: 16,
  toolCalls: 24,
  gmailReads: 6,
  gmailWrites: 10,
  callsPerResponse: 5,
  modelTimeoutMs: 120_000,
  /** Each model call's output ceiling, reasoning included: any call may write the answer. */
  finalOutputTokens: 12_000,
  answerChars: 30_000,
  /** The broker's deadline for the whole turn. */
  turnMs: 240_000,
} as const

export const turnSpec = z
  .object({
    model: modelId,
    reasoning: reasoningLevel.nullable(),
    // `drive` and `driveCalls` go only to runtimes with driveContract 1
    // (runtime 0.6.0): earlier runtimes' strict copies of this schema refuse them.
    tools: z
      .object({
        // Batch runtimes may also get gmail.threads.read (§68).
        gmail: z.array(gmailToolOperation).max(10),
        web: z.boolean(),
        drive: z.array(driveOperation).max(4).optional(),
      })
      .strict(),
    limits: z
      .object({
        modelCalls: z.number().int().min(1).max(batchCeilings.modelCalls),
        toolCalls: z.number().int().min(0).max(batchCeilings.toolCalls),
        gmailCalls: z.number().int().min(0).max(turnCeilings.gmailCalls),
        // Mailbox batch runtimes only (§67); earlier runtimes' strict copies refuse them.
        gmailReads: z
          .number()
          .int()
          .min(0)
          .max(batchCeilings.gmailReads)
          .optional(),
        gmailWrites: z
          .number()
          .int()
          .min(0)
          .max(batchCeilings.gmailWrites)
          .optional(),
        callsPerResponse: z
          .number()
          .int()
          .min(1)
          .max(batchCeilings.callsPerResponse)
          .optional(),
        driveCalls: z
          .number()
          .int()
          .min(0)
          .max(turnCeilings.driveCalls)
          .optional(),
      })
      .strict(),
  })
  .strict()
export type TurnSpec = z.infer<typeof turnSpec>

export const startMessage = z
  .object({
    type: z.literal("start"),
    envelope: z.record(z.string(), z.unknown()),
    turn: turnSpec,
  })
  .strict()
export type StartMessage = z.infer<typeof startMessage>

const requestId = z.number().int().positive()
// Provider items (function calls, reasoning) are referenced, never resent:
// the broker substitutes the exact item it received from the provider.
export const inputItem = z.union([
  z
    .object({
      role: z.enum(["system", "developer", "user", "assistant"]),
      content: z.string().max(500_000),
    })
    .strict(),
  z
    .object({
      type: z.literal("provider"),
      ref: z.string().regex(/^r\d{1,4}$/),
    })
    .strict(),
  z
    .object({
      type: z.literal("function_call_output"),
      call_id: z.string().min(1).max(200),
      output: z.string().max(200_000),
    })
    .strict(),
])
export type InputItem = z.infer<typeof inputItem>

export const toolOffer = z
  .object({
    name: z.string().regex(/^[a-z][a-z_]{0,63}$/),
    description: z.string().min(1).max(1000),
  })
  .strict()

export const modelRequest = z
  .object({
    type: z.literal("model"),
    id: requestId,
    input: z.array(inputItem).min(1).max(200),
    tools: z.array(toolOffer).max(10),
    toolChoice: z.enum(["auto", "none"]),
    format: z
      .object({
        type: z.literal("json_schema"),
        name: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        strict: z.literal(true),
        schema: z.record(z.string(), z.unknown()),
      })
      .strict(),
    // The broker clamps this to the ceiling of the runtime's mode.
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(batchCeilings.modelTimeoutMs)
      .optional(),
  })
  .strict()
export type ModelRequest = z.infer<typeof modelRequest>

export const toolRequest = z
  .object({
    type: z.literal("tool"),
    id: requestId,
    callId: z.string().min(1).max(200),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(turnCeilings.toolTimeoutMs)
      .optional(),
  })
  .strict()
export type ToolRequest = z.infer<typeof toolRequest>

export const turnAnswer = z
  .object({
    // Earlier runtimes cap their own answers at 12,000 characters.
    text: z.string().min(1).max(batchCeilings.answerChars),
    citations: z.array(z.uuid()).max(8),
    insufficientEvidence: z.boolean(),
  })
  .strict()
export type TurnAnswer = z.infer<typeof turnAnswer>

/** Failures a runtime may report; anything else is a protocol violation. */
export const runtimeErrorCode = z.enum([
  "answer_json_invalid",
  "answer_schema_invalid",
  "answer_citations_invalid",
  "provider_unavailable",
  "candidate_mismatch",
  "preview_expired",
  "runtime_failed",
])
export type RuntimeErrorCode = z.infer<typeof runtimeErrorCode>

export const runtimeMessage = z.discriminatedUnion("type", [
  modelRequest,
  toolRequest,
  z.object({ type: z.literal("result"), result: z.unknown() }).strict(),
  z.object({ type: z.literal("error"), code: runtimeErrorCode }).strict(),
])
export type RuntimeMessage = z.infer<typeof runtimeMessage>

// Only what the loop needs: message text, call identity and arguments, and a
// reference for reasoning items whose encrypted content stays in the broker.
export const providerItem = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("message"),
      text: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("function_call"),
      name: z.string(),
      callId: z.string(),
      arguments: z.string(),
    })
    .strict(),
  z.object({ type: z.literal("reasoning") }).strict(),
])
export type ProviderItem = z.infer<typeof providerItem>

export const modelReply = z.union([
  z
    .object({
      type: z.literal("model"),
      id: requestId,
      ok: z.literal(true),
      items: z.array(
        z.object({ ref: z.string(), item: providerItem }).strict()
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal("model"),
      id: requestId,
      ok: z.literal(false),
      code: z.literal("provider_unavailable"),
    })
    .strict(),
])
export type ModelReply = z.infer<typeof modelReply>

export const toolReply = z
  .object({ type: z.literal("tool"), id: requestId, output: z.unknown() })
  .strict()
export type ToolReply = z.infer<typeof toolReply>
export type BrokerReply = ModelReply | ToolReply
