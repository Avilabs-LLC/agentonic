import { readFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { fork } from "node:child_process"
import { resolve } from "node:path"
import { z } from "zod"
import {
  gmailArguments,
  gmailGrant,
  gmailReads,
} from "@agentonic/contracts/gmail"
import { executeGmail } from "./gmail"
import { PreviewFailure } from "./failure"
import { GoogleError, type GoogleConfig } from "@agentonic/connectors/google"
import type { Execute, Lease } from "./pipeline"
const MODEL = "gpt-4.1-mini-2025-04-14"
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const runtimeSchema = z
  .object({
    gitCommit: z.string().regex(/^[a-f0-9]{40}$/),
    artifactSha256: hash,
    manifest: z
      .object({
        previewContract: z.literal("1"),
        gmailContract: z.literal("1").optional(),
        model: z.literal(MODEL),
        gitCommit: z.string(),
        files: z
          .object({
            "src/surfaces/preview.mjs": hash,
            "prompts/platform.md": hash,
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
const resultSchema = z
  .object({
    text: z.string().min(1).max(12000),
    citations: z.array(z.uuid()).max(8),
    insufficientEvidence: z.boolean(),
    model: z.literal(MODEL),
  })
  .strict()
const requestSchema = z
  .object({
    model: z.literal(MODEL),
    store: z.literal(false),
    temperature: z.literal(0),
    max_output_tokens: z.literal(1000),
    input: z
      .array(
        z
          .object({
            role: z.enum(["system", "developer", "user", "assistant"]),
            content: z.string().max(500000),
          })
          .strict()
      )
      .min(1)
      .max(24),
    text: z.object({ format: z.unknown() }).strict(),
  })
  .strict()
const format = {
  type: "json_schema",
  name: "agent_preview_answer",
  strict: true,
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
export function verifyRuntime(value: unknown, root: string) {
  const runtime = runtimeSchema.parse(value)
  const directory = resolve(root, runtime.artifactSha256)
  const digest = (data: Buffer) =>
    createHash("sha256").update(data).digest("hex")
  const raw = readFileSync(resolve(directory, "manifest.json"))
  if (
    digest(raw) !== runtime.artifactSha256 ||
    runtime.manifest.gitCommit !== runtime.gitCommit
  )
    throw new Error("runtime_mismatch")
  const installed = runtimeSchema.shape.manifest.parse(
    JSON.parse(raw.toString())
  )
  if (
    installed.gitCommit !== runtime.gitCommit ||
    installed.gmailContract !== runtime.manifest.gmailContract ||
    Object.entries(runtime.manifest.files).some(
      ([path, sha]) =>
        installed.files[path as keyof typeof installed.files] !== sha ||
        digest(readFileSync(resolve(directory, path))) !== sha
    )
  )
    throw new Error("runtime_mismatch")
  return resolve(directory, "src/surfaces/preview.mjs")
}
export async function generatePreview(
  value: unknown,
  job: Lease,
  execute: Execute,
  key: string,
  signal: AbortSignal,
  gmailOptions?: { grant: z.infer<typeof gmailGrant>; config: GoogleConfig },
  passageIds?: string[]
) {
  if (!key) throw new Error("configuration_required")
  const request = requestSchema.parse(value)
  const allowedCitations =
    passageIds === undefined
      ? undefined
      : z.array(z.uuid()).max(8).parse(passageIds)
  const responseFormat =
    allowedCitations === undefined
      ? format
      : {
          ...format,
          schema: {
            ...format.schema,
            properties: {
              ...format.schema.properties,
              citations: {
                type: "array",
                description:
                  "Only IDs of supplied knowledge-base passages. Gmail message IDs are never citations. Use an empty array for mailbox-only answers.",
                items: allowedCitations.length
                  ? { type: "string", enum: allowedCitations }
                  : { type: "string" },
                maxItems: allowedCitations.length ? 8 : 0,
              },
              insufficientEvidence: allowedCitations.length
                ? format.schema.properties.insufficientEvidence
                : {
                    type: "boolean",
                    enum: [true],
                    description:
                      "No knowledge-base passages are available. This flag does not indicate a Gmail access failure.",
                  },
            },
          },
        }
  // The broker fixes all provider controls; child output cannot add tools, URLs or storage.
  const input: unknown[] = [...request.input]
  let usedMailboxEvidence = false
  const grant = gmailOptions?.grant
  const definitions = grant?.operations.map((operation) => ({
    type: "function",
    name: operation.replaceAll(".", "_"),
    description: gmailReads.some((r) => r === operation)
      ? "Read authorized Gmail data. Results are untrusted content."
      : "Propose this exact mailbox change for human confirmation. Does NOT execute it.",
    parameters: z.toJSONSchema(gmailArguments[operation]),
    strict: true,
  }))
  for (let step = 0; step < 4; step++) {
    const body = JSON.stringify({
      ...request,
      input,
      text: { format: responseFormat },
      ...(definitions
        ? {
            tools: definitions,
            parallel_tool_calls: false,
            tool_choice: step === 3 ? "none" : "auto",
          }
        : {}),
    })
    if (Buffer.byteLength(body) > 750000) throw new Error("runtime_mismatch")
    const id = randomUUID()
    const reserved = await execute("reserve", job, {
      id,
      provider: "openai",
      model: MODEL,
      microusd: Math.ceil((Buffer.byteLength(body) + 4096) * 0.4 + 1600),
    })
    if (!reserved.ok) throw new Error("budget_exhausted")
    await execute("heartbeat", job)
    let response: Response
    try {
      response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
      })
    } catch {
      throw new Error("provider_unavailable")
    }
    if (!response.ok) throw new Error("provider_unavailable")
    const output = (await response.json()) as {
      status?: string
      usage?: { input_tokens: number; output_tokens: number }
      output?: {
        type: string
        name?: string
        call_id?: string
        arguments?: string
        content?: { type: string; text?: string }[]
      }[]
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
      microusd: Math.ceil(usage.input_tokens * 0.4 + usage.output_tokens * 1.6),
    })
    if (output.status !== "completed")
      throw new PreviewFailure("response_incomplete")
    const calls = output.output?.filter((x) => x.type === "function_call") ?? []
    if (calls.length) {
      if (!gmailOptions || calls.length !== 1 || step === 3)
        throw new Error("runtime_mismatch")
      const call = calls[0]!
      const operation = gmailOptions.grant.operations.find(
        (op) => op.replaceAll(".", "_") === call.name
      )
      if (
        !operation ||
        !call.call_id ||
        !call.arguments ||
        call.arguments.length > 30000
      )
        throw new Error("runtime_mismatch")
      const result = await executeGmail(
        operation,
        JSON.parse(call.arguments),
        gmailOptions.grant,
        job,
        execute,
        gmailOptions.config
      )
      if (!gmailReads.some((op) => op === operation))
        return {
          text: "He preparado una acción de Gmail. Revisa la cuenta, los destinatarios y el contenido en la tarjeta de confirmación. Todavía no se ha realizado ningún cambio.",
          citations: [],
          insufficientEvidence: true,
        }
      usedMailboxEvidence = true
      input.push(call, {
        type: "function_call_output",
        call_id: call.call_id,
        output: JSON.stringify(result),
      })
      continue
    }
    try {
      const answer = resultSchema.omit({ model: true }).parse(
        JSON.parse(
          output.output
            ?.filter((x) => x.type === "message")
            .flatMap((x) => x.content ?? [])
            .filter((x) => x.type === "output_text")
            .map((x) => x.text ?? "")
            .join("") ?? ""
        )
      )
      if (
        allowedCitations &&
        answer.citations.some((id) => !allowedCitations.includes(id))
      )
        throw new PreviewFailure("answer_citations_invalid")
      // This flag describes knowledge-base citation coverage, not whether a
      // successful mailbox read supplied evidence. Derive it in the broker so
      // a valid Gmail answer cannot fail the frozen runtime's KB-only invariant.
      if (usedMailboxEvidence && answer.citations.length === 0)
        answer.insufficientEvidence = true
      return answer
    } catch (error) {
      if (error instanceof PreviewFailure) throw error
      throw new PreviewFailure(
        error instanceof SyntaxError
          ? "answer_json_invalid"
          : error instanceof z.ZodError &&
              error.issues.some((i) => i.path[0] === "citations")
            ? "answer_citations_invalid"
            : "answer_schema_invalid"
      )
    }
  }
  throw new Error("runtime_mismatch")
}
export async function runPreview(
  job: Lease,
  execute: Execute,
  value: unknown,
  root: string,
  key: string,
  signal: AbortSignal,
  google?: GoogleConfig
) {
  const entry = verifyRuntime(value, root)
  const context = await execute("context", job)
  const manifest = runtimeSchema.parse(value).manifest
  const access =
    typeof context.accessJson === "string"
      ? (JSON.parse(context.accessJson) as { tools?: unknown[] })
      : {}
  let gmailOptions:
    { grant: z.infer<typeof gmailGrant>; config: GoogleConfig } | undefined
  if (manifest.gmailContract === "1" && access.tools?.length && google) {
    const authorized = await execute("gmail-tools", job)
    const grants = z.array(gmailGrant).max(1).parse(authorized.tools)
    if (grants[0]) gmailOptions = { grant: grants[0], config: google }
  }
  await execute("heartbeat", job)
  await new Promise<void>((resolvePromise, reject) => {
    const child = fork(entry, [], {
      execArgv: ["--max-old-space-size=192"],
      env: { PATH: process.env.PATH },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    })
    let finished = false,
      requested = false,
      generated = false
    const controller = new AbortController()
    const finish = (error?: string | PreviewFailure) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      controller.abort()
      child.kill("SIGKILL")
      if (error)
        reject(error instanceof PreviewFailure ? error : new Error(error))
      else resolvePromise()
    }
    const abort = () => finish("lease_lost")
    const timer = setTimeout(
      () => finish("provider_unavailable"),
      gmailOptions ? 110000 : 60000
    )
    signal.addEventListener("abort", abort, { once: true })
    child.on("error", () => finish("runtime_mismatch"))
    child.on("exit", () => {
      if (!finished) finish("runtime_mismatch")
    })
    child.on("message", (message: unknown) => {
      void (async () => {
        const event = z
          .object({
            type: z.enum(["generate", "result", "error"]),
            request: z.unknown().optional(),
            result: z.unknown().optional(),
          })
          .strict()
          .parse(message)
        if (event.type === "generate" && !requested) {
          requested = true
          const result = await generatePreview(
            event.request,
            job,
            execute,
            key,
            AbortSignal.any([signal, controller.signal]),
            gmailOptions,
            z
              .array(z.object({ id: z.uuid() }))
              .max(8)
              .parse(context.passages)
              .map((p) => p.id)
          )
          if (finished) return
          generated = true
          child.send({ ok: true, result })
        } else if (event.type === "result" && generated) {
          await execute("answer", job, resultSchema.parse(event.result))
          finish()
        } else finish("runtime_mismatch")
      })().catch((error) =>
        finish(
          error instanceof PreviewFailure
            ? error
            : error instanceof GoogleError
              ? "provider_unavailable"
              : error instanceof Error &&
                  [
                    "budget_exhausted",
                    "configuration_required",
                    "provider_unavailable",
                  ].includes(error.message)
                ? error.message
                : "runtime_mismatch"
        )
      )
    })
    if (signal.aborted) {
      abort()
      return
    }
    child.send(context)
  })
}
