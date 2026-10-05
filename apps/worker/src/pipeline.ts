import { rerankJob } from "./reranking"
import { runPreview, verifyRuntime } from "./runtime"
import { fileURLToPath } from "node:url"
import { answer } from "./answer"
import { randomUUID, createHash } from "node:crypto"
import { fork } from "node:child_process"
import { chunkPages, type PageText } from "./chunking"
import { RAG_MODEL, RAG_DIMENSIONS } from "@agentonic/contracts/rag"
export type Lease = {
  id: string
  token: string
  kind: "ingest" | "purge" | "retrieve"
}
export type Execute = (
  operation: string,
  job: Lease,
  payload?: Record<string, unknown>
) => Promise<Record<string, unknown>>
export type Configuration = {
  supabaseUrl: string
  storageKey: string
  /** Paid and credentialed calls; an agent copy's go through its gateway. */
  providers: import("./providers").Providers
  allowTools?: boolean
  rerankEnabled?: boolean
  runtimeRoot?: string
}
const microusd = (tokens: number) => Math.ceil(tokens * 0.06) // voyage-4: USD 0.06 / 1M tokens; 2026-09-14 list price, no free-credit assumption.
export async function embed(
  texts: string[],
  type: "document" | "query",
  job: Lease,
  execute: Execute,
  key: string,
  signal: AbortSignal
): Promise<number[][]> {
  if (!key) throw new Error("configuration_required")
  const id = randomUUID()
  // UTF-8 bytes plus generous per-input prompt overhead is a conservative token ceiling.
  const ceiling = texts.reduce(
    (n, t) => n + Buffer.byteLength(t, "utf8") + 1024,
    0
  )
  const reserved = await execute("reserve", job, {
    id,
    provider: "voyage",
    model: RAG_MODEL,
    microusd: microusd(ceiling),
  })
  if (!reserved.ok) throw new Error("budget_exhausted")
  await execute("heartbeat", job)
  let response: Response
  try {
    response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model: RAG_MODEL,
        input_type: type,
        output_dimension: RAG_DIMENSIONS,
        truncation: false,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]),
    })
  } catch {
    throw new Error("provider_unavailable")
  }
  if (!response.ok)
    throw new Error("provider_unavailable", {
      cause: { status: response.status },
    })
  const body = (await response.json()) as {
    data?: { index: number; embedding: number[] }[]
    usage?: { total_tokens: number }
  }
  const tokens = body.usage?.total_tokens
  if (!Number.isSafeInteger(tokens) || tokens! < 0)
    throw new Error("provider_unavailable")
  await execute("settle", job, { id, tokens, microusd: microusd(tokens!) })
  if (!Array.isArray(body.data) || body.data.length !== texts.length)
    throw new Error("provider_unavailable")
  const sorted = [...body.data].sort((a, b) => a.index - b.index)
  if (
    sorted.some(
      (v, index) =>
        v.index !== index ||
        !Array.isArray(v.embedding) ||
        v.embedding.length !== RAG_DIMENSIONS ||
        !v.embedding.every(Number.isFinite) ||
        v.embedding.every((n) => n === 0)
    )
  )
    throw new Error("provider_unavailable")
  return sorted.map((v) => v.embedding)
}
export async function parsePdf(
  bytes: Buffer,
  signal: AbortSignal
): Promise<PageText[]> {
  return new Promise((resolve, reject) => {
    const child = fork(new URL("./pdf-parser.mjs", import.meta.url), [], {
      execArgv: ["--max-old-space-size=192"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH },
    })
    let done = false
    const finish = (error?: string, pages?: PageText[]) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      child.kill("SIGKILL")
      if (error) reject(new Error(error))
      else resolve(pages!)
    }
    const abort = () => finish("lease_lost")
    const timer = setTimeout(() => finish("invalid_document"), 30000)
    signal.addEventListener("abort", abort, { once: true })
    child.on("message", (message: { error?: string; pages?: PageText[] }) =>
      finish(message.error, message.pages)
    )
    child.on("error", () => finish("invalid_document"))
    child.on("exit", () => {
      if (!done) finish("invalid_document")
    })
    if (signal.aborted) {
      abort()
      return
    }
    child.send({ data: bytes.toString("base64") })
  })
}
async function storage(
  config: Configuration,
  path: string,
  init: RequestInit,
  signal: AbortSignal
) {
  if (!config.storageKey) throw new Error("configuration_required")
  const response = await fetch(`${config.supabaseUrl}/storage/v1/${path}`, {
    ...init,
    headers: {
      ...init.headers,
      apikey: config.storageKey,
      ...(config.storageKey.startsWith("sb_secret_")
        ? {}
        : { Authorization: `Bearer ${config.storageKey}` }),
    },
    signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]),
  })
  return response
}
export async function processJob(
  job: Lease,
  execute: Execute,
  config: Configuration,
  signal: AbortSignal
) {
  const data = await execute("read", job)
  if (job.kind === "retrieve") {
    if (data.preview)
      verifyRuntime(
        data.runtime,
        config.runtimeRoot ??
          fileURLToPath(new URL("../../../.local/runtime/", import.meta.url))
      )
    if (data.preview && !data.hasCollections) {
      await execute("empty-search", job)
    } else {
      const vectors = await config.providers.embed(
        [String(data.retrievalQuery ?? data.query)],
        "query",
        job,
        execute,
        signal
      )
      await execute("search", job, {
        embedding: vectors[0],
        rerank: config.rerankEnabled === true,
      })
      if (config.rerankEnabled)
        await rerankJob(
          String(data.retrievalQuery ?? data.query),
          job,
          execute,
          config.providers,
          signal
        )
    }
    if (data.preview)
      await runPreview(
        job,
        execute,
        data.runtime,
        config.runtimeRoot ??
          fileURLToPath(new URL("../../../.local/runtime/", import.meta.url)),
        config.providers,
        signal,
        config.allowTools
      )
    else if (data.generateAnswer)
      await answer(job, execute, config.providers, signal)
    return
  }
  const key = String(data.objectKey)
  // The database supplies exact reserved paths. Never accept a URL or bucket from queued input.
  if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key))
    throw new Error("invalid_document")
  if (job.kind === "purge") {
    await execute("heartbeat", job)
    const removed = await storage(
      config,
      "object/agentonic-documents",
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: [key] }),
      },
      signal
    )
    if (!removed.ok && removed.status !== 404)
      throw new Error("storage_unavailable")
    await execute("purged", job)
    return
  }
  const response = await storage(
    config,
    `object/agentonic-documents/${key}`,
    {},
    signal
  )
  if (!response.ok) throw new Error("storage_unavailable")
  const reader = response.body?.getReader()
  if (!reader) throw new Error("storage_unavailable")
  const buffers: Uint8Array[] = []
  let length = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    length += value.length
    if (length > 10485760) {
      await reader.cancel()
      throw new Error("invalid_document")
    }
    buffers.push(value)
  }
  const bytes = Buffer.concat(buffers)
  if (
    bytes.length !== data.size ||
    createHash("sha256").update(bytes).digest("hex") !== data.sha256
  )
    throw new Error("invalid_document")
  const pdf = data.contentType === "application/pdf"
  let pages: PageText[]
  if (pdf) pages = await parsePdf(bytes, signal)
  else {
    try {
      pages = [
        { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) },
      ]
    } catch {
      throw new Error("invalid_document")
    }
  }
  const chunks = chunkPages(pages)
  const embedded: ({ embedding: number[] } & (typeof chunks)[number])[] = []
  for (let start = 0; start < chunks.length; start += 16) {
    await execute("heartbeat", job)
    const batch = chunks.slice(start, start + 16)
    const vectors = await config.providers.embed(
      batch.map((c) => c.text),
      "document",
      job,
      execute,
      signal
    )
    embedded.push(
      ...batch.map((chunk, index) => ({ ...chunk, embedding: vectors[index]! }))
    )
  }
  await execute("publish", job, {
    parser: pdf ? "pdf-parse-2.4.5" : "text-v1",
    chunks: embedded,
  })
}
