import { afterEach, expect, it, vi } from "vitest"
import {
  partialAnswerText,
  readResponseStream,
} from "../apps/worker/src/stream"
import { respond } from "../apps/worker/src/providers"
import type { Execute, Lease } from "../apps/worker/src/pipeline"

// §68: answers that appear as they are written.
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})
const sse = (events: unknown[], cut = 7) => {
  const text = events
    .map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`)
    .join("")
  const bytes = new TextEncoder().encode(text)
  // Arrives in small, arbitrary pieces, as a network delivers it.
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += cut)
        controller.enqueue(bytes.slice(i, i + cut))
      controller.close()
    },
  })
}
const deltas = (json: string, size = 5) =>
  Array.from({ length: Math.ceil(json.length / size) }, (_, i) => ({
    type: "response.output_text.delta",
    delta: json.slice(i * size, i * size + size),
  }))

it("decodes the answer text from a JSON prefix, escapes included", () => {
  expect(partialAnswerText('{"text":"Hola')).toBe("Hola")
  expect(partialAnswerText('{ "text" : "Línea 1\\nLínea \\"2\\"')).toBe(
    'Línea 1\nLínea "2"'
  )
  expect(partialAnswerText('{"text":"a\\u00e9b')).toBe("aéb")
  // An escape cut by the end waits for the next piece.
  expect(partialAnswerText('{"text":"a\\')).toBe("a")
  expect(partialAnswerText('{"text":"a\\u00')).toBe("a")
  expect(partialAnswerText('{"text":"Fin.","citations":[]')).toBe("Fin.")
  expect(partialAnswerText('{"citations":[],"text":"x')).toBeUndefined()
  expect(partialAnswerText("")).toBeUndefined()
})

it("reads a stream in pieces, reports the text so far and returns the final response", async () => {
  const answer = JSON.stringify({
    text: "Resumen: 3 correos.",
    citations: [],
    insufficientEvidence: true,
  })
  const final = { status: "completed", output: [], usage: {} }
  const seen: string[] = []
  const result = await readResponseStream(
    sse([...deltas(answer), { type: "response.completed", response: final }]),
    (text) => seen.push(text)
  )
  expect(result).toEqual(final)
  expect(seen.at(-1)).toBe(answer)
  expect(
    await readResponseStream(sse([{ type: "response.created" }]), () => {})
  ).toBeUndefined()
  await expect(
    readResponseStream(sse([{ type: "error", message: "x" }]), () => {})
  ).rejects.toThrow("provider_unavailable")
})

it("streams a model call: writes the answer as it comes, then settles from the final response", async () => {
  const job: Lease = {
    id: "10000000-0000-4000-8000-000000000001",
    token: "10000000-0000-4000-8000-000000000002",
    kind: "retrieve",
  }
  const answer = JSON.stringify({
    text: "Hola, aquí está el resumen de tus correos.",
    citations: [],
    insufficientEvidence: true,
  })
  const final = {
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 40 },
    output: [
      { type: "message", content: [{ type: "output_text", text: answer }] },
    ],
  }
  let now = 1_000_000
  vi.spyOn(Date, "now").mockImplementation(() => (now += 400))
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
    async () =>
      new Response(
        sse([
          ...deltas(answer, 4),
          { type: "response.completed", response: final },
        ]),
        { headers: { "content-type": "text/event-stream" } }
      )
  )
  vi.stubGlobal("fetch", fetch)
  const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
  const outcome = await respond(
    {
      model: "gpt-5.4",
      reasoning: "medium",
      input: [{ role: "user", content: "Synthetic" }],
      format: { type: "json_schema" },
      stream: true,
      timeoutMs: 1000,
    },
    job,
    execute,
    "synthetic",
    new AbortController().signal
  )
  expect(outcome).toEqual({
    kind: "response",
    status: "completed",
    output: final.output,
  })
  expect(JSON.parse(String(fetch.mock.calls[0]![1].body)).stream).toBe(true)
  const partials = execute.mock.calls
    .filter(([op]) => op === "partial")
    .map(([, , p]) => (p as { text: string }).text)
  // Throttled: a few writes, each longer than the last, all prefixes of the text.
  expect(partials.length).toBeGreaterThan(1)
  expect(partials.length).toBeLessThan(deltas(answer, 4).length)
  for (const [n, text] of partials.entries()) {
    expect("Hola, aquí está el resumen de tus correos.").toContain(text)
    if (n) expect(text.length).toBeGreaterThan(partials[n - 1]!.length)
  }
  expect(execute.mock.calls.map(([op]) => op)).toContain("settle")
  // A stream cut short may have been billed: no settlement, outcome unknown.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(sse(deltas(answer, 4))))
  )
  const cut = vi.fn<Execute>().mockResolvedValue({ ok: true })
  expect(
    await respond(
      {
        model: "gpt-5.4",
        reasoning: "medium",
        input: [{ role: "user", content: "Synthetic" }],
        format: { type: "json_schema" },
        stream: true,
        timeoutMs: 1000,
      },
      job,
      cut,
      "synthetic",
      new AbortController().signal
    )
  ).toEqual({ kind: "uncertain" })
  expect(cut.mock.calls.map(([op]) => op)).not.toContain("settle")
})
