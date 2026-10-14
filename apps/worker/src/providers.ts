// Provider access without provider keys. Every paid or credentialed call an
// agent makes (OpenAI, Voyage, Browserbase, Gmail, Drive) goes through a Providers
// object. The knowledge worker and the evaluator hold the keys and call
// providers directly. An agent copy holds none: its Providers forward each
// call to the host's gateway, which holds the keys and runs the same direct
// call with the copy's own deployment credentials. Reservations and
// settlements happen where the key is used, under reservation IDs the copy
// never sees, so a copy cannot spend without a reservation or misstate usage.
import { randomUUID } from "node:crypto"
import { z } from "zod"
import { gmailGrant } from "@agentonic/contracts/gmail"
import { driveGrant } from "@agentonic/contracts/drive"
import { webArguments, type WebOperation } from "@agentonic/contracts/web"
import { modelConfiguration } from "@agentonic/contracts/models"
import {
  DEFAULT_PREVIEW_MODEL,
  previewModel,
  type PreviewModel,
} from "@agentonic/contracts/preview-models"
import {
  batchCeilings,
  turnCeilings,
} from "@agentonic/contracts/runtime-protocol"
import { GoogleError, type GoogleConfig } from "@agentonic/connectors/google"
import { connectionKeys } from "@agentonic/connectors/secrets"
import { embed, parsePdf, type Execute, type Lease } from "./pipeline"
import { rerank, type Passage } from "./reranking"
import { executeWeb } from "./web"
import { executeGmail } from "./gmail"
import { executeDrive } from "./drive"
import { PreviewFailure } from "./failure"
import { partialAnswerText, readResponseStream } from "./stream"
import { releaseRefused } from "./refusal"
import {
  INVALID,
  jobCall,
  statements,
  type GatewayClient,
  type GatewayProvider,
  type GatewayQuery,
} from "./gateway"
import {
  previewCost,
  previewModelProfile,
  previewReservation,
} from "./preview-models"

/** One OpenAI Responses request. The side holding the key fixes model controls and reserves from the exact bytes it sends. */
export type ModelCall = {
  model: PreviewModel
  reasoning: string | null
  input: string | unknown[]
  format: Record<string, unknown>
  instructions?: string
  tools?: Record<string, unknown>[]
  toolChoice?: "auto" | "none"
  /** Mailbox batch turns (§67): several tool calls in one response. */
  parallelToolCalls?: boolean
  /** Mailbox batch turns: a larger output ceiling for the final answer. */
  maxOutputTokens?: number
  /** Chats and previews of batch runtimes: show the answer as it is written (§68). */
  stream?: boolean
  timeoutMs: number
}
/** Options a mailbox batch turn passes to Gmail tools (§67). */
export type GmailOptions = { batch?: boolean }
/**
 * budget: the reservation was refused, nothing was sent. uncertain: the
 * request may have reached the provider; its reservation stays and it is
 * never replayed. response: settled with the provider's reported usage.
 */
export type ModelOutcome =
  | { kind: "budget" }
  | { kind: "uncertain" }
  | { kind: "response"; status?: string; output: Record<string, unknown>[] }

export type Capabilities = {
  models: boolean
  embeddings: boolean
  web: boolean
  gmail: boolean
}
/**
 * Drive needs the same Google settings as Gmail, so its availability follows
 * Gmail's and the gateway's capability reply keeps its original shape.
 */
export type Providers = Capabilities & {
  drive: boolean
  respond(
    call: ModelCall,
    job: Lease,
    execute: Execute,
    signal: AbortSignal
  ): Promise<ModelOutcome>
  embed(
    texts: string[],
    type: "document" | "query",
    job: Lease,
    execute: Execute,
    signal: AbortSignal
  ): Promise<number[][]>
  rerank(
    query: string,
    passages: Passage[],
    job: Lease,
    execute: Execute,
    signal: AbortSignal
  ): Promise<Passage[]>
  webTool(
    operation: WebOperation,
    args: unknown,
    job: Lease,
    execute: Execute,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<Record<string, unknown>>
  gmailTool(
    operation: string,
    args: unknown,
    grant: z.infer<typeof gmailGrant>,
    job: Lease,
    execute: Execute,
    options?: GmailOptions
  ): Promise<unknown>
  driveTool(
    operation: string,
    args: unknown,
    grant: z.infer<typeof driveGrant>,
    job: Lease,
    execute: Execute,
    signal: AbortSignal
  ): Promise<unknown>
}

const OPENAI_RESPONSES = "https://api.openai.com/v1/responses"

/** The only OpenAI request path: reserve, report, send once, settle. */
export async function respond(
  call: ModelCall,
  job: Lease,
  execute: Execute,
  key: string,
  signal: AbortSignal
): Promise<ModelOutcome> {
  if (!key) throw new Error("configuration_required")
  const { model, reasoning } = modelConfiguration.parse({
    model: call.model,
    reasoning: call.reasoning,
  })
  const profile = previewModelProfile(model, reasoning)
  // A batch final answer may ask for more room, never less, up to 16,384.
  const maxOutput = Math.min(
    16384,
    Math.max(profile.maxOutput, call.maxOutputTokens ?? 0)
  )
  const body = JSON.stringify({
    model,
    store: false,
    ...(call.instructions === undefined
      ? {}
      : { instructions: call.instructions }),
    input: call.input,
    text: { format: call.format },
    ...(model === DEFAULT_PREVIEW_MODEL
      ? { temperature: 0, max_output_tokens: 1000 }
      : {
          reasoning: { effort: reasoning },
          max_output_tokens: maxOutput,
          include: ["reasoning.encrypted_content"],
        }),
    ...(call.stream ? { stream: true } : {}),
    ...(call.tools?.length
      ? {
          tools: call.tools,
          parallel_tool_calls: call.parallelToolCalls === true,
          tool_choice: call.toolChoice ?? "auto",
        }
      : {}),
  })
  if (Buffer.byteLength(body) > turnCeilings.requestBytes)
    throw new Error("runtime_mismatch")
  const id = randomUUID()
  const reserved = await execute("reserve", job, {
    id,
    provider: "openai",
    model,
    microusd: previewReservation(
      model,
      body,
      reasoning,
      model === DEFAULT_PREVIEW_MODEL ? undefined : maxOutput
    ),
  })
  if (!reserved.ok) return { kind: "budget" }
  await execute("heartbeat", job)
  let response: Response
  try {
    response = await fetch(OPENAI_RESPONSES, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body,
      signal: AbortSignal.any([
        signal,
        AbortSignal.timeout(
          Math.max(1, Math.min(call.timeoutMs, batchCeilings.modelTimeoutMs))
        ),
      ]),
    })
  } catch {
    if (signal.aborted) throw new Error("lease_lost")
    return { kind: "uncertain" }
  }
  if (!response.ok) {
    await releaseRefused(response, id, job, execute)
    throw new Error("provider_unavailable")
  }
  let output: {
    status?: string
    usage?: { input_tokens: number; output_tokens: number }
    output?: Record<string, unknown>[]
  }
  if (call.stream && response.body) {
    // The answer so far reaches the person at most once a second, best
    // effort; a write still running is skipped, never queued.
    let shown = 0,
      last = 0,
      writing = false
    const show = (text: string) => {
      const partial = partialAnswerText(text)
      if (
        partial === undefined ||
        partial.length <= shown ||
        writing ||
        Date.now() - last < 1000
      )
        return
      shown = partial.length
      last = Date.now()
      writing = true
      void execute("partial", job, {
        text: partial.slice(0, batchCeilings.answerChars),
      })
        .catch(() => {})
        .finally(() => {
          writing = false
        })
    }
    let final: Record<string, unknown> | undefined
    try {
      final = await readResponseStream(response.body, show)
    } catch (error) {
      if (signal.aborted) throw new Error("lease_lost")
      if (error instanceof Error && error.message === "provider_unavailable")
        throw error
      // A stream cut short may have been billed: its reservation stays.
      return { kind: "uncertain" }
    }
    if (!final) return { kind: "uncertain" }
    output = final as typeof output
  } else output = (await response.json()) as typeof output
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
  return {
    kind: "response",
    status: output.status,
    output: Array.isArray(output.output) ? output.output : [],
  }
}

/** The provider keys a holder's configuration names; Gmail needs all of its settings. */
export function providerKeys(env: Record<string, string | undefined>) {
  return {
    openaiKey: env.OPENAI_API_KEY ?? "",
    voyageKey: env.VOYAGE_API_KEY ?? "",
    browserbaseKey: env.BROWSERBASE_API_KEY,
    google:
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.AGENTONIC_CONNECTION_KEY
        ? {
            clientId: env.GOOGLE_CLIENT_ID,
            clientSecret: env.GOOGLE_CLIENT_SECRET,
            keys: connectionKeys(env),
            redirectUri:
              env.GOOGLE_REDIRECT_URI ??
              "http://localhost:3101/api/connections/google/callback",
          }
        : undefined,
  }
}

/** Provider access for a process that holds the keys itself. */
export function directProviders(keys: {
  openaiKey?: string
  voyageKey?: string
  browserbaseKey?: string
  google?: GoogleConfig
}): Providers {
  return {
    models: Boolean(keys.openaiKey),
    embeddings: Boolean(keys.voyageKey),
    web: Boolean(keys.browserbaseKey),
    gmail: Boolean(keys.google),
    drive: Boolean(keys.google),
    respond: (call, job, execute, signal) =>
      respond(call, job, execute, keys.openaiKey ?? "", signal),
    embed: (texts, type, job, execute, signal) =>
      embed(texts, type, job, execute, keys.voyageKey ?? "", signal),
    rerank: (query, passages, job, execute, signal) =>
      rerank(query, passages, job, execute, keys.voyageKey ?? "", signal),
    webTool: async (operation, args, job, execute, signal, timeoutMs) => {
      if (!keys.browserbaseKey) throw new Error("configuration_required")
      return executeWeb(
        operation,
        args,
        job,
        execute,
        keys.browserbaseKey,
        signal,
        timeoutMs
      )
    },
    gmailTool: async (operation, args, grant, job, execute, options) => {
      if (!keys.google) throw new Error("configuration_required")
      return executeGmail(
        operation,
        args,
        grant,
        job,
        execute,
        keys.google,
        options
      )
    },
    driveTool: async (operation, args, grant, job, execute, signal) => {
      if (!keys.google) throw new Error("configuration_required")
      return executeDrive(
        operation,
        args,
        grant,
        job,
        execute,
        keys.google,
        parsePdf,
        signal
      )
    },
  }
}

// ---------------------------------------------------------------------------
// The wire between an agent copy and its gateway

export const PROVIDER_OPERATIONS = [
  "capabilities",
  "respond",
  "embed",
  "rerank",
  "web",
  "gmail",
  "drive",
] as const
export type ProviderOperation = (typeof PROVIDER_OPERATIONS)[number]

const modelCall = z
  .object({
    model: previewModel,
    reasoning: z.string().nullable(),
    input: z.union([z.string(), z.array(z.unknown())]),
    format: z.record(z.string(), z.unknown()),
    instructions: z.string().optional(),
    tools: z.array(z.record(z.string(), z.unknown())).max(16).optional(),
    toolChoice: z.enum(["auto", "none"]).optional(),
    // Batch turns only (§67); copies on earlier brokers never send these.
    parallelToolCalls: z.boolean().optional(),
    maxOutputTokens: z.number().int().min(1).max(16384).optional(),
    stream: z.boolean().optional(),
    timeoutMs: z.number().int().positive(),
  })
  .strict()
const payloads = {
  respond: modelCall,
  // Copies embed only the question they are answering.
  embed: z
    .object({
      texts: z.array(z.string().min(1).max(64_000)).length(1),
      type: z.literal("query"),
    })
    .strict(),
  rerank: z
    .object({
      query: z.string(),
      passages: z.array(z.object({ id: z.string(), text: z.string() })),
    })
    .strict(),
  web: z
    .object({
      operation: z.enum(Object.keys(webArguments) as [WebOperation]),
      args: z.unknown(),
      // A research deadline can leave 0 ms; the web call allows at least 1.
      timeoutMs: z.number().int().nonnegative(),
    })
    .strict(),
  gmail: z
    .object({
      operation: z.string(),
      args: z.unknown(),
      grant: gmailGrant,
      batch: z.boolean().optional(),
    })
    .strict(),
  drive: z
    .object({ operation: z.string(), args: z.unknown(), grant: driveGrant })
    .strict(),
}

/** Failures that cross the wire as names; anything else becomes runtime_mismatch. */
const FAILURES = new Set([
  "budget_exhausted",
  "configuration_required",
  "provider_unavailable",
  "lease_lost",
  "runtime_mismatch",
  "gmail_denied",
  "drive_denied",
])
const PREVIEW_FAILURES = new Set([
  "answer_json_invalid",
  "answer_citations_invalid",
  "answer_schema_invalid",
  "response_incomplete",
])
const GOOGLE_FAILURES = new Set([
  "reconnect",
  "unavailable",
  "uncertain",
  "rejected",
])
/**
 * A database or network error, which crosses as its code like any gateway
 * call. Provider failures (Google, web) use lowercase names and never match.
 */
const transportCode = (error: unknown) => {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : ""
  return /^[0-9A-Z]{5}$/.test(code) || /^[A-Z][A-Z_]{2,40}$/.test(code)
}
function failureName(error: unknown) {
  if (error instanceof PreviewFailure) return `preview:${error.diagnostic}`
  if (error instanceof GoogleError) return `google:${error.code}`
  if (error instanceof Error && FAILURES.has(error.message))
    return error.message
  return "runtime_mismatch"
}
/** The copy's side: the same error the direct call would have thrown. */
export function providerFailure(name: string): Error {
  const [kind, code = ""] = name.split(":")
  if (kind === "preview" && PREVIEW_FAILURES.has(code))
    return new PreviewFailure(code as PreviewFailure["diagnostic"])
  if (kind === "google" && GOOGLE_FAILURES.has(code))
    return new GoogleError(code as GoogleError["code"])
  return new Error(FAILURES.has(name) ? name : "runtime_mismatch")
}

export const providerReply = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), failure: z.string() }).strict(),
])
export type ProviderReply =
  { ok: true; value: unknown } | { ok: false; failure: string }

/**
 * The gateway's side: checks one copy request and runs it with the host's
 * keys. `execute` carries the copy's own deployment credentials, so the
 * database authorizes every reservation, settlement and tool check exactly as
 * if the copy made them. Database and network errors are thrown unchanged.
 */
export async function serveProvider(
  providers: Providers,
  operation: string,
  job: Lease | null,
  payload: unknown,
  execute: Execute,
  signal: AbortSignal
): Promise<ProviderReply> {
  try {
    if (operation === "capabilities") {
      const { models, embeddings, web, gmail } = providers
      return { ok: true, value: { models, embeddings, web, gmail } }
    }
    if (!job) throw new Error("runtime_mismatch")
    let value: unknown
    if (operation === "respond") {
      const call = payloads.respond.parse(payload)
      value = await providers.respond(call, job, execute, signal)
    } else if (operation === "embed") {
      const call = payloads.embed.parse(payload)
      value = await providers.embed(call.texts, call.type, job, execute, signal)
    } else if (operation === "rerank") {
      const call = payloads.rerank.parse(payload)
      value = await providers.rerank(
        call.query,
        call.passages,
        job,
        execute,
        signal
      )
    } else if (operation === "web") {
      const call = payloads.web.parse(payload)
      value = await providers.webTool(
        call.operation,
        call.args,
        job,
        execute,
        signal,
        Math.min(call.timeoutMs, turnCeilings.toolTimeoutMs)
      )
    } else if (operation === "gmail") {
      const call = payloads.gmail.parse(payload)
      value = await providers.gmailTool(
        call.operation,
        call.args,
        call.grant,
        job,
        execute,
        { batch: call.batch === true }
      )
    } else if (operation === "drive") {
      const call = payloads.drive.parse(payload)
      value = await providers.driveTool(
        call.operation,
        call.args,
        call.grant,
        job,
        execute,
        signal
      )
    } else throw new Error("runtime_mismatch")
    return { ok: true, value }
  } catch (error) {
    if (transportCode(error)) throw error
    return { ok: false, failure: failureName(error) }
  }
}

/** Sends one provider request to the gateway and returns its reply. */
export type ProviderSend = (
  operation: ProviderOperation,
  job: Lease | null,
  payload: unknown,
  signal?: AbortSignal
) => Promise<ProviderReply>

const capabilities = z
  .object({
    models: z.boolean(),
    embeddings: z.boolean(),
    web: z.boolean(),
    gmail: z.boolean(),
  })
  .strict()
/** Asks the gateway which providers its host has keys for. */
export async function gatewayCapabilities(send: ProviderSend) {
  const reply = await send("capabilities", null, {})
  if (!reply.ok) throw providerFailure(reply.failure)
  return capabilities.parse(reply.value)
}

/** Provider access for an agent copy: every call goes to the gateway; the copy holds no key. */
export function gatewayProviders(
  send: ProviderSend,
  available: Capabilities
): Providers {
  const call = async (
    operation: ProviderOperation,
    job: Lease,
    payload: unknown,
    signal?: AbortSignal
  ) => {
    const reply = await send(operation, job, payload, signal)
    if (signal?.aborted) throw new Error("lease_lost")
    if (!reply.ok) throw providerFailure(reply.failure)
    return reply.value
  }
  const needs = (capability: boolean) => {
    if (!capability) throw new Error("configuration_required")
  }
  return {
    ...available,
    drive: available.gmail,
    respond: async (request, job, _execute, signal) => {
      needs(available.models)
      const outcome = z
        .discriminatedUnion("kind", [
          z.object({ kind: z.literal("budget") }),
          z.object({ kind: z.literal("uncertain") }),
          z.object({
            kind: z.literal("response"),
            status: z.string().optional(),
            output: z.array(z.record(z.string(), z.unknown())),
          }),
        ])
        .parse(await call("respond", job, request, signal))
      return outcome
    },
    embed: async (texts, type, job, _execute, signal) => {
      needs(available.embeddings)
      return z
        .array(z.array(z.number()))
        .length(texts.length)
        .parse(await call("embed", job, { texts, type }, signal))
    },
    rerank: async (query, passages, job, _execute, signal) => {
      needs(available.embeddings)
      return z
        .array(z.object({ id: z.uuid(), text: z.string() }))
        .parse(await call("rerank", job, { query, passages }, signal))
    },
    webTool: async (operation, args, job, _execute, signal, timeoutMs) => {
      needs(available.web)
      return z
        .record(z.string(), z.unknown())
        .parse(await call("web", job, { operation, args, timeoutMs }, signal))
    },
    gmailTool: async (operation, args, grant, job, _execute, options) => {
      needs(available.gmail)
      return call("gmail", job, {
        operation,
        args,
        grant,
        ...(options?.batch ? { batch: true } : {}),
      })
    },
    driveTool: async (operation, args, grant, job, _execute, signal) => {
      needs(available.gmail)
      return call("drive", job, { operation, args, grant }, signal)
    },
  }
}

/** A provider call's longest wait: a Gmail search reads up to ten messages. */
export const PROVIDER_TIMEOUT_MS = 180_000

/** The copy's side of the wire: one provider request with its own credentials. */
export function gatewaySend(
  client: Pick<GatewayClient, "call">,
  deploymentId: string,
  secret: string
): ProviderSend {
  return async (operation, job, payload, signal) => {
    try {
      return providerReply.parse(
        await client.call(
          "provider",
          [
            operation,
            deploymentId,
            secret,
            job?.id ?? null,
            job?.token ?? null,
            JSON.stringify(payload),
          ],
          { signal, timeoutMs: PROVIDER_TIMEOUT_MS }
        )
      )
    } catch (error) {
      if (signal?.aborted) throw new Error("lease_lost")
      throw error
    }
  }
}

const leaseId = z.uuid().nullable()
/**
 * The gateway's side of the wire. Each call runs with the calling copy's own
 * deployment ID and secret: `query` runs the same fixed statements a copy may
 * send itself, so the database authorizes every step as if the copy made it.
 */
export function providerGateway(
  providers: Providers,
  query: GatewayQuery
): GatewayProvider {
  return async (args, signal) => {
    const [operation, deploymentId, secret, jobId, token, payload] = args
    const job = leaseId.safeParse(jobId),
      lease = leaseId.safeParse(token)
    let body: unknown
    try {
      body = JSON.parse(payload ?? "")
    } catch {
      body = undefined
    }
    if (
      !job.success ||
      !lease.success ||
      (job.data === null) !== (lease.data === null) ||
      body === undefined
    )
      throw Object.assign(new Error("invalid"), { code: INVALID })
    const execute: Execute = async (op, held, values = {}) =>
      (await query(statements[jobCall(op)], [
        op,
        deploymentId ?? null,
        secret ?? null,
        held.id,
        held.token,
        JSON.stringify(values),
      ])) as Record<string, unknown>
    return serveProvider(
      providers,
      operation ?? "",
      job.data && lease.data
        ? { id: job.data, token: lease.data, kind: "retrieve" }
        : null,
      body,
      execute,
      signal
    )
  }
}
