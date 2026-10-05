import { afterEach, expect, it, vi } from "vitest"
import { chunkPages } from "../apps/worker/src/chunking"
import { directProviders } from "../apps/worker/src/providers"
import {
  embed,
  processJob,
  type Execute,
  type Lease,
} from "../apps/worker/src/pipeline"
const job: Lease = {
  id: "10000000-0000-4000-8000-000000000001",
  token: "10000000-0000-4000-8000-000000000002",
  kind: "ingest",
}
const signal = new AbortController().signal
const execute = vi.fn<Execute>()
const storage = {
  url: "https://example.supabase.co",
  headers: async () => ({ apikey: "publishable", Authorization: "Bearer t" }),
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})
it("keeps page citations, bounded chunks and deterministic overlap for long text", () => {
  const pages = [
    {
      page: 1,
      text: "# Garantía\n\n" + "La garantía dura tres años. ".repeat(250),
    },
    { page: 2, text: "Second page evidence." },
  ]
  const chunks = chunkPages(pages)
  expect(chunks.length).toBeGreaterThan(2)
  expect(chunks.every((c) => c.text.length <= 2400)).toBe(true)
  expect(chunks[0]!.locator).toMatchObject({ page: 1, section: "Garantía" })
  expect(chunks.at(-1)!.locator.page).toBe(2)
  expect(chunks).toEqual(chunkPages(pages))
  expect(chunks[1]!.locator.start).toBeLessThan(chunks[0]!.locator.end)
})
it("rejects empty or excessive extracted text", () => {
  expect(() => chunkPages([{ text: " \n " }])).toThrow("invalid_document")
  expect(() => chunkPages([{ text: "x".repeat(2_000_001) }])).toThrow(
    "too_much_text"
  )
})
it("does not contact Voyage when its budget reservation is denied", async () => {
  execute.mockResolvedValue({ ok: false })
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  await expect(
    embed(["test"], "document", job, execute, "fixture", signal)
  ).rejects.toThrow("budget_exhausted")
  expect(fetch).not.toHaveBeenCalled()
})
it("uses matching dimensions/input type and settles provider usage once", async () => {
  execute.mockResolvedValue({ ok: true })
  const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      usage: { total_tokens: 12 },
      data: [{ index: 0, embedding: vector }],
    })
  )
  vi.stubGlobal("fetch", fetch)
  expect(
    await embed(["¿Garantía?"], "query", job, execute, "fixture", signal)
  ).toEqual([vector])
  const request = JSON.parse(fetch.mock.calls[0]![1].body)
  expect(request).toMatchObject({
    model: "voyage-4",
    input_type: "query",
    output_dimension: 1024,
    truncation: false,
  })
  expect(execute.mock.calls.filter((c) => c[0] === "settle")).toHaveLength(1)
})
it("keeps a reservation when the provider outcome is unknown", async () => {
  execute.mockResolvedValue({ ok: true })
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("timeout")))
  await expect(
    embed(["test"], "document", job, execute, "fixture", signal)
  ).rejects.toThrow("provider_unavailable")
  expect(execute.mock.calls.some((c) => c[0] === "settle")).toBe(false)
})
it("rejects wrong dimensions rather than publishing incompatible vectors", async () => {
  execute.mockResolvedValue({ ok: true })
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        usage: { total_tokens: 1 },
        data: [{ index: 0, embedding: [1, 2] }],
      })
    )
  )
  await expect(
    embed(["test"], "document", job, execute, "fixture", signal)
  ).rejects.toThrow("provider_unavailable")
})
it("storage failure leaves purge records available for retry", async () => {
  execute.mockResolvedValue({
    objectKey:
      "10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002",
  })
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
  )
  await expect(
    processJob(
      { ...job, kind: "purge" },
      execute,
      {
        storage,
        providers: directProviders({}),
      },
      signal
    )
  ).rejects.toThrow("storage_unavailable")
  expect(execute.mock.calls.some((c) => c[0] === "purged")).toBe(false)
})
it("successful blob removal precedes database hard purge", async () => {
  execute.mockResolvedValue({
    objectKey:
      "10000000-0000-4000-8000-000000000001/10000000-0000-4000-8000-000000000002",
  })
  const fetch = vi.fn().mockResolvedValue(Response.json([]))
  vi.stubGlobal("fetch", fetch)
  await processJob(
    { ...job, kind: "purge" },
    execute,
    {
      storage,
      providers: directProviders({}),
    },
    signal
  )
  expect(fetch.mock.calls[0]![0]).toBe(
    "https://example.supabase.co/storage/v1/object/agentonic-documents"
  )
  // The worker's own account, never a secret key.
  expect(fetch.mock.calls[0]![1].headers).toMatchObject({
    apikey: "publishable",
    Authorization: "Bearer t",
  })
  expect(execute.mock.calls.at(-1)?.[0]).toBe("purged")
})
function syntheticPdf(pageCount = 1, linesPerPage = 1) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  for (let page = 0; page < pageCount; page++) {
    const line = "Synthetic warranty lasts three years. ".repeat(3)
    const stream = `BT /F1 9 Tf 50 750 Td ${Array.from({ length: linesPerPage }, () => `(${line}) Tj 0 -12 Td`).join(" ")} ET`
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + page * 2} 0 R >>`,
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
    )
  }
  let pdf = "%PDF-1.4\n"
  const offsets = [0]
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf),
    size = objects.length + 1
  pdf += `xref\n0 ${size}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join(
      ""
    )}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}
it("parses a real synthetic PDF in the isolated parser and preserves page numbers", async () => {
  const { parsePdf } = await import("../apps/worker/src/pipeline")
  const pages = await parsePdf(syntheticPdf(), signal)
  expect(pages[0]).toMatchObject({ page: 1 })
  expect(pages[0]!.text).toContain("three years")
})
it("delivers all extracted pages when the PDF result exceeds the IPC buffer", async () => {
  const { parsePdf } = await import("../apps/worker/src/pipeline")
  const pages = await parsePdf(syntheticPdf(60, 24), signal)
  expect(pages).toHaveLength(60)
  expect(pages.at(-1)).toMatchObject({ page: 60 })
  expect(Buffer.byteLength(JSON.stringify(pages))).toBeGreaterThan(128_000)
  expect(pages.every((page) => page.text.includes("three years"))).toBe(true)
}, 20000)

it("runs opt-in candidate search and reranking before publishing retrieval", async () => {
  const passages = [1, 2].map((n) => ({
    id: `10000000-0000-4000-8000-${String(n + 10).padStart(12, "0")}`,
    text: `Synthetic evidence ${n}`,
  }))
  execute.mockImplementation(async (operation) =>
    operation === "read"
      ? { query: "Evidence?", generateAnswer: false }
      : operation === "rerank-context"
        ? { passages }
        : { ok: true }
  )
  const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0))
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        usage: { total_tokens: 5 },
        data: [{ index: 0, embedding: vector }],
      })
    )
    .mockResolvedValueOnce(
      Response.json({
        usage: { total_tokens: 20 },
        data: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.1 },
        ],
      })
    )
  vi.stubGlobal("fetch", fetch)
  await processJob(
    { ...job, kind: "retrieve" },
    execute,
    {
      providers: directProviders({ voyageKey: "fixture" }),
      rerankEnabled: true,
    },
    signal
  )
  expect(execute.mock.calls.find((c) => c[0] === "search")?.[2]).toMatchObject({
    rerank: true,
  })
  expect(execute.mock.calls.at(-1)).toEqual([
    "select-matches",
    { ...job, kind: "retrieve" },
    { ids: [passages[1]!.id, passages[0]!.id] },
  ])
  expect(fetch).toHaveBeenCalledTimes(2)
})
