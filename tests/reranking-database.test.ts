import { beforeEach, afterEach, expect, it } from "vitest"
import {
  createRagFixture,
  collection,
  embedding,
  id,
  member,
} from "../scripts/rag-benchmark/fixture"
let f: Awaited<ReturnType<typeof createRagFixture>>
beforeEach(async () => {
  f = await createRagFixture()
})
afterEach(async () => {
  await f.db.close()
})
async function candidates(generateAnswer = false) {
  const object = await f.upload()
  await f.worker(await f.claim(), "publish", {
    parser: "text-v1",
    chunks: Array.from({ length: 40 }, (_, n) => ({
      text: `Garantía sintética ${n}`,
      locator: { start: n * 30, end: n * 30 + 25 },
      embedding,
    })),
  })
  await f.actor()
  const q = await f.rag("search", {
    query: "garantía",
    collectionIds: [collection],
    generateAnswer,
  })
  const job = await f.claim()
  await f.worker(job, "search", { embedding, rerank: true })
  const context = (await f.worker(job, "rerank-context")) as {
    passages: { id: string; text: string }[]
  }
  return { job, q, object, ids: context.passages.map((p) => p.id) }
}
it("retains 32 authorized candidates, then publishes only the selected eight in model order", async () => {
  const { job, q, ids } = await candidates()
  expect(ids).toHaveLength(32)
  const selected = ids.slice(24).reverse()
  await f.worker(job, "select-matches", { ids: selected })
  await f.actor()
  const result = await f.rag("result", { id: q.id })
  expect(result.status).toBe("succeeded")
  expect(result.matches.map((p) => p.id)).toEqual(selected)
})
it.each(["foreign", "duplicates", "too-many", "empty"])(
  "rejects %s selection",
  async (kind) => {
    const { job, ids } = await candidates()
    const chosen =
      kind === "foreign"
        ? [id(999)]
        : kind === "duplicates"
          ? [ids[0], ids[0]]
          : kind === "empty"
            ? []
            : ids.slice(0, 9)
    await expect(
      f.worker(job, "select-matches", { ids: chosen })
    ).rejects.toThrow()
  }
)
it("never exposes an oversized context to the answer model", async () => {
  const { job } = await candidates(true)
  await expect(f.worker(job, "context")).rejects.toThrow()
})
it("deletion during the provider call fences result selection", async () => {
  const { job, ids, object } = await candidates()
  await f.actor()
  await f.command("document.remove", { objectId: object })
  await expect(
    f.worker(job, "select-matches", { ids: ids.slice(0, 8) })
  ).rejects.toThrow()
})
it("revocation before provider access denies the candidate text", async () => {
  const { job } = await candidates()
  await f.sql(
    "UPDATE agentonic.workspace_members SET status='suspended' WHERE id=$1",
    [member]
  )
  await expect(f.worker(job, "rerank-context")).rejects.toThrow()
})
it("reranker reservations use the existing cap and uncertain charges block finalization", async () => {
  const { job, ids } = await candidates()
  await f.sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=100 WHERE provider='voyage'"
  )
  expect(
    await f.worker(job, "reserve", {
      id: id(800),
      provider: "voyage",
      model: "rerank-2.5-lite",
      microusd: 101,
    })
  ).toEqual({ ok: false, code: "budget_exhausted" })
  expect(
    await f.worker(job, "reserve", {
      id: id(801),
      provider: "voyage",
      model: "rerank-2.5-lite",
      microusd: 100,
    })
  ).toEqual({ ok: true })
  await expect(
    f.worker(job, "select-matches", { ids: ids.slice(0, 8) })
  ).rejects.toThrow()
})
it("settles ranking charges, retaining ledger history and finishing read-only searches", async () => {
  const { job, ids } = await candidates()
  await f.sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=100 WHERE provider='voyage'"
  )
  await f.worker(job, "reserve", {
    id: id(801),
    provider: "voyage",
    model: "rerank-2.5-lite",
    microusd: 100,
  })
  await f.worker(job, "settle", { id: id(801), tokens: 100, microusd: 2 })
  await f.worker(job, "select-matches", { ids: ids.slice(0, 8) })
  expect(
    (
      await f.sql(
        "SELECT committed_microusd FROM agentonic.retrieval_provider_budgets WHERE provider='voyage'"
      )
    ).rows
  ).toEqual([{ committed_microusd: 2 }])
})

it("completes an empty candidate set without manufacturing evidence", async () => {
  await f.actor()
  const queued = await f.rag("search", {
    query: "Missing evidence",
    collectionIds: [collection],
  })
  const job = await f.claim()
  await f.worker(job, "search", { embedding, rerank: true })
  expect(await f.worker(job, "rerank-context")).toEqual({ passages: [] })
  await f.worker(job, "select-matches", { ids: [] })
  await f.actor()
  expect(await f.rag("result", { id: queued.id })).toMatchObject({
    status: "succeeded",
    matches: [],
  })
})
