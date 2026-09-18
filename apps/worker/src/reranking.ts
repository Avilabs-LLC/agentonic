import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { Execute, Lease } from "./pipeline"

export const RERANK_MODEL = "rerank-2.5-lite"
export const RETRIEVAL_PROFILE =
  "hybrid40-rrf60-candidates32-rerank2.5lite-preserve8-v2"
export const RERANK_TIMEOUT_MS = 15_000
// Voyage list price, verified 2026-09-18. Do not assume free credits.
export const rerankCost = (tokens: number) => Math.ceil(tokens * 0.02)
const passagesSchema = z
  .array(z.object({ id: z.uuid(), text: z.string().min(1).max(2400) }))
  .max(32)
export type Passage = z.infer<typeof passagesSchema>[number]

export function distinctPassages(passages: Passage[]): Passage[] {
  const seen = new Set<string>()
  return passages.filter(({ text }) => {
    // Exact duplicates only: similar passages can contain materially different facts.
    if (seen.has(text)) return false
    seen.add(text)
    return true
  })
}

/** Preserve the distinct evidence in the original hybrid top eight.
 * Ranking may reorder it, but may replace only duplicate slots. This guarantees
 * baseline passage coverage without a query-specific heuristic or extra context.
 */
export function selectCoveragePreserving(
  passages: Passage[],
  rankedIds: string[]
): Passage[] {
  const candidates = distinctPassages(passages)
  const byId = new Map(candidates.map((passage) => [passage.id, passage]))
  if (
    rankedIds.length !== candidates.length ||
    new Set(rankedIds).size !== candidates.length ||
    rankedIds.some((id) => !byId.has(id))
  )
    throw new Error("provider_unavailable")
  const protectedIds = new Set(
    distinctPassages(passages.slice(0, 8)).map((p) => p.id)
  )
  for (const id of rankedIds) {
    if (protectedIds.size >= 8) break
    protectedIds.add(id)
  }
  return rankedIds
    .filter((id) => protectedIds.has(id))
    .map((id) => byId.get(id)!)
}

export async function rerank(
  query: string,
  passages: Passage[],
  job: Lease,
  execute: Execute,
  key: string,
  signal: AbortSignal
): Promise<Passage[]> {
  const candidates = distinctPassages(passagesSchema.parse(passages))
  if (new Set(passages.map((p) => p.id)).size !== passages.length)
    throw new Error("provider_unavailable")
  if (candidates.length <= 1) return candidates
  if (!key) throw new Error("configuration_required")
  // Current question plus at most two prior questions fits this byte ceiling.
  if (!query.trim() || Buffer.byteLength(query, "utf8") > 16_000)
    throw new Error("provider_unavailable")
  signal.throwIfAborted()
  const id = randomUUID()
  const ceiling = candidates.reduce(
    (sum, p) => sum + Buffer.byteLength(query + p.text, "utf8") + 1024,
    0
  )
  if (ceiling > 550_000) throw new Error("provider_unavailable")
  const reserved = await execute("reserve", job, {
    id,
    provider: "voyage",
    model: RERANK_MODEL,
    microusd: rerankCost(ceiling),
  })
  if (!reserved.ok) throw new Error("budget_exhausted")
  // Recheck live lease/source permissions immediately before sending text.
  await execute("heartbeat", job)
  const fresh = z
    .object({ passages: passagesSchema })
    .parse(await execute("rerank-context", job))
  if (
    passages.some(
      (p) => !fresh.passages.some((f) => f.id === p.id && f.text === p.text)
    )
  )
    throw new Error("lease_lost")
  let body: unknown
  try {
    const response = await fetch("https://api.voyageai.com/v1/rerank", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: RERANK_MODEL,
        query,
        documents: candidates.map((p) => p.text),
        top_k: candidates.length,
        return_documents: false,
        truncation: false,
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(RERANK_TIMEOUT_MS)]),
    })
    if (!response.ok)
      throw new Error("provider_unavailable", {
        cause: { status: response.status },
      })
    body = await response.json()
  } catch (error) {
    // No fallback/retry here: an unknown charge remains reserved.
    throw new Error("provider_unavailable", {
      cause: error instanceof Error ? error.cause : undefined,
    })
  }
  const usage = z
    .object({
      usage: z.object({ total_tokens: z.number().int().nonnegative().safe() }),
    })
    .safeParse(body)
  if (!usage.success) throw new Error("provider_unavailable")
  await execute("settle", job, {
    id,
    tokens: usage.data.usage.total_tokens,
    microusd: rerankCost(usage.data.usage.total_tokens),
  })
  const result = z
    .object({
      data: z.array(
        z.object({
          index: z.number().int().nonnegative(),
          relevance_score: z.number().finite(),
        })
      ),
    })
    .safeParse(body)
  if (
    !result.success ||
    result.data.data.length !== candidates.length ||
    new Set(result.data.data.map((r) => r.index)).size !== candidates.length ||
    result.data.data.some((r) => r.index >= candidates.length)
  )
    throw new Error("provider_unavailable")
  // Stable ties use the original hybrid rank. Scores are not calibrated probabilities.
  const rankedIds = result.data.data
    .sort((a, b) => b.relevance_score - a.relevance_score || a.index - b.index)
    .map((r) => candidates[r.index]!.id)
  return selectCoveragePreserving(passages, rankedIds)
}

export async function rerankJob(
  query: string,
  job: Lease,
  execute: Execute,
  key: string,
  signal: AbortSignal
) {
  const context = z
    .object({ passages: passagesSchema })
    .parse(await execute("rerank-context", job))
  const selected = await rerank(
    query,
    context.passages,
    job,
    execute,
    key,
    signal
  )
  await execute("select-matches", job, { ids: selected.map((p) => p.id) })
}
