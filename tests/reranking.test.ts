import { afterEach, expect, it, vi } from "vitest"
import {
  rerank,
  rerankJob,
  RERANK_TIMEOUT_MS,
  selectCoveragePreserving,
  distinctPassages,
} from "../apps/worker/src/reranking"
import type { Execute, Lease } from "../apps/worker/src/pipeline"
import { retrievalMetrics } from "../scripts/rag-benchmark/metrics"
const job: Lease = {
  id: "10000000-0000-4000-8000-000000000001",
  token: "10000000-0000-4000-8000-000000000002",
  kind: "retrieve",
}
const passages = Array.from({ length: 12 }, (_, i) => ({
  id: `10000000-0000-4000-8000-${String(i + 10).padStart(12, "0")}`,
  text: `Synthetic passage ${i}`,
}))
const signal = new AbortController().signal
const execute = vi.fn<Execute>(async (operation) =>
  operation === "rerank-context" ? { passages } : { ok: true }
)
const response = () => ({
  usage: { total_tokens: 1000 },
  data: passages.map((_, index) => ({ index, relevance_score: index / 12 })),
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  execute.mockClear()
})
it("reranks a wider pool, retains original citation IDs, and settles real usage", async () => {
  const fetch = vi.fn().mockResolvedValue(Response.json(response()))
  vi.stubGlobal("fetch", fetch)
  await rerankJob("Pregunta", job, execute, "fixture", signal)
  expect(execute).toHaveBeenLastCalledWith("select-matches", job, {
    ids: passages
      .slice(0, 8)
      .reverse()
      .map((p) => p.id),
  })
  expect(execute.mock.calls.find((c) => c[0] === "settle")?.[2]).toMatchObject({
    tokens: 1000,
    microusd: 20,
  })
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
    model: "rerank-2.5-lite",
    top_k: 12,
    truncation: false,
    return_documents: false,
  })
})
it("deduplicates exact passages but preserves distinct facts and stable ties", async () => {
  const dup = [...passages, { ...passages[0]!, id: job.id }]
  const run: Execute = async (op) =>
    op === "rerank-context" ? { passages: dup } : { ok: true }
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        usage: { total_tokens: 20 },
        data: passages
          .map((_, index) => ({ index, relevance_score: 0.5 }))
          .reverse(),
      })
    )
  )
  expect(await rerank("query", dup, job, run, "fixture", signal)).toEqual(
    passages.slice(0, 8)
  )
})
it("does not charge for zero or one distinct passage", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  expect(await rerank("query", [], job, execute, "", signal)).toEqual([])
  expect(
    await rerank("query", passages.slice(0, 1), job, execute, "", signal)
  ).toEqual(passages.slice(0, 1))
  expect(fetch).not.toHaveBeenCalled()
  expect(execute).not.toHaveBeenCalled()
})
it("denied budget prevents the provider call", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  await expect(
    rerank(
      "query",
      passages,
      job,
      async () => ({ ok: false }),
      "fixture",
      signal
    )
  ).rejects.toThrow("budget_exhausted")
  expect(fetch).not.toHaveBeenCalled()
})
it("revoked or changed evidence prevents sending text after reservation", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  await expect(
    rerank(
      "query",
      passages,
      job,
      async (op) => (op === "rerank-context" ? { passages: [] } : { ok: true }),
      "fixture",
      signal
    )
  ).rejects.toThrow("lease_lost")
  expect(fetch).not.toHaveBeenCalled()
})
it.each(["timeout", "http", "usage"])(
  "keeps uncertain %s charges reserved and does not select a fallback",
  async (failure) => {
    vi.stubGlobal(
      "fetch",
      failure === "timeout"
        ? vi.fn().mockRejectedValue(new Error("timeout"))
        : vi
            .fn()
            .mockResolvedValue(
              failure === "http"
                ? new Response(null, { status: 503 })
                : Response.json({ data: response().data })
            )
    )
    await expect(
      rerankJob("query", job, execute, "fixture", signal)
    ).rejects.toThrow("provider_unavailable")
    expect(
      execute.mock.calls.some(
        (c) => c[0] === "settle" || c[0] === "select-matches"
      )
    ).toBe(false)
  }
)
it.each(["duplicate", "out-of-range", "nonfinite", "missing"])(
  "settles known usage but rejects %s provider rankings",
  async (failure) => {
    const body = response()
    if (failure === "duplicate") body.data[1]!.index = 0
    if (failure === "out-of-range") body.data[0]!.index = 99
    if (failure === "nonfinite") body.data[0]!.relevance_score = NaN
    if (failure === "missing") body.data.pop()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body)))
    await expect(
      rerankJob("query", job, execute, "fixture", signal)
    ).rejects.toThrow("provider_unavailable")
    expect(execute.mock.calls.filter((c) => c[0] === "settle")).toHaveLength(1)
    expect(execute.mock.calls.some((c) => c[0] === "select-matches")).toBe(
      false
    )
  }
)
it("honors an already cancelled lease and a fixed timeout", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  await expect(
    rerank("query", passages, job, execute, "fixture", AbortSignal.abort())
  ).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
  expect(RERANK_TIMEOUT_MS).toBe(15000)
})
it("computes ranking metrics without counting duplicates or unanswerable cases as hits", () => {
  expect(retrievalMetrics(["wrong", "a", "a"], ["a", "b"])).toMatchObject({
    hit: 1,
    recall: 0.5,
    reciprocalRank: 0.5,
  })
  expect(retrievalMetrics(["a"], [])).toEqual({
    hit: null,
    recall: null,
    reciprocalRank: null,
    ndcg: null,
  })
  expect(retrievalMetrics(["a", "b"], ["a", "b"]).ndcg).toBe(1)
})

it("protects both sides of the observed comparison even when the reranker demotes one", () => {
  const candidates = passages.map((p, i) => ({
    ...p,
    text:
      i === 1
        ? "Aurora warranty: 36 months"
        : i === 3
          ? "Brisa warranty: 18 months"
          : p.text,
  }))
  const rank = [3, 8, 9, 10, 11, 0, 4, 5, 6, 7, 2, 1].map(
    (i) => candidates[i]!.id
  )
  const selected = selectCoveragePreserving(candidates, rank)
  expect(selected[0]!.text).toContain("Brisa")
  expect(selected.map((p) => p.text)).toContain("Aurora warranty: 36 months")
  expect(selected).toHaveLength(8)
})
it("uses freed duplicate slots for the best additional evidence", () => {
  const candidates = [
    passages[0]!,
    { ...passages[0]!, id: job.id },
    ...passages.slice(1),
  ]
  const rank = distinctPassages(candidates)
    .reverse()
    .map((p) => p.id)
  const selected = selectCoveragePreserving(candidates, rank)
  expect(selected[0]).toEqual(passages[11])
  expect(selected.map((p) => p.id)).toEqual(
    expect.arrayContaining(passages.slice(0, 7).map((p) => p.id))
  )
  expect(new Set(selected.map((p) => p.text)).size).toBe(8)
})
it("preserves baseline coverage under adversarial permutations and duplicate placement", () => {
  let seed = 713
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296
  for (let trial = 0; trial < 200; trial++) {
    const pool = Array.from(
      { length: 1 + Math.floor(next() * 32) },
      (_, i) => ({
        id: `10000000-0000-4000-8000-${String(100 + i).padStart(12, "0")}`,
        text: `Evidence ${Math.floor(next() * 20)}`,
      })
    )
    const ranks = distinctPassages(pool).map((p) => p.id)
    for (let i = ranks.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[ranks[i], ranks[j]] = [ranks[j]!, ranks[i]!]
    }
    const selected = selectCoveragePreserving(pool, ranks)
    expect(selected.map((p) => p.text)).toEqual(
      expect.arrayContaining(
        distinctPassages(pool.slice(0, 8)).map((p) => p.text)
      )
    )
    expect(selected).toHaveLength(Math.min(8, distinctPassages(pool).length))
    expect(new Set(selected.map((p) => p.text)).size).toBe(selected.length)
    expect(selected.every((p) => pool.includes(p))).toBe(true)
  }
})
it("rejects invented, repeated or incomplete ranking IDs at selection", () => {
  for (const rank of [
    [job.id],
    passages.map((p) => p.id).fill(passages[0]!.id),
    [],
  ]) {
    expect(() => selectCoveragePreserving(passages, rank)).toThrow(
      "provider_unavailable"
    )
  }
})
