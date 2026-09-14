import { afterEach, expect, it, vi } from "vitest"
import { answer } from "../apps/worker/src/answer"
import type { Execute, Lease } from "../apps/worker/src/pipeline"
const id = "10000000-0000-4000-8000-000000000001"
const job: Lease = { id, token: id, kind: "retrieve" },
  signal = new AbortController().signal
const execute = vi.fn<Execute>()
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
})
function context() {
  execute.mockImplementation(async (operation) =>
    operation === "context"
      ? {
          query: "Warranty?",
          passages: [{ id, text: "Warranty lasts three years." }],
        }
      : { ok: true }
  )
}
it("does not call a model without evidence", async () => {
  execute.mockResolvedValue({ query: "Warranty?", passages: [] })
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  await answer(job, execute, "", signal)
  expect(fetch).not.toHaveBeenCalled()
  expect(execute.mock.calls.at(-1)?.[2]).toMatchObject({
    insufficientEvidence: true,
    citations: [],
  })
})
it("reserves before generation, disables stored responses and publishes validated citations", async () => {
  context()
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({
        status: "completed",
        usage: { input_tokens: 40, output_tokens: 20 },
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  text: "Three years.",
                  citations: [id],
                  insufficientEvidence: false,
                }),
              },
            ],
          },
        ],
      })
    )
  vi.stubGlobal("fetch", fetch)
  await answer(job, execute, "fixture", signal)
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
    store: false,
    max_output_tokens: 1000,
    text: { format: { type: "json_schema", strict: true } },
  })
  expect(execute.mock.calls.map((c) => c[0])).toEqual([
    "context",
    "reserve",
    "heartbeat",
    "settle",
    "answer",
  ])
})
it("cannot fabricate a citation to unpublished knowledge", async () => {
  context()
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValue(
        Response.json({
          status: "completed",
          usage: { input_tokens: 40, output_tokens: 20 },
          output: [
            {
              type: "message",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    text: "Three years.",
                    citations: ["20000000-0000-4000-8000-000000000001"],
                    insufficientEvidence: false,
                  }),
                },
              ],
            },
          ],
        })
      )
  )
  await expect(answer(job, execute, "fixture", signal)).rejects.toThrow(
    "provider_unavailable"
  )
  expect(execute.mock.calls.some((c) => c[0] === "answer")).toBe(false)
})
it("does not call OpenAI if the reservation exceeds its budget", async () => {
  execute.mockImplementation(async (operation) =>
    operation === "context"
      ? { query: "Warranty?", passages: [{ id, text: "Three years." }] }
      : { ok: false }
  )
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  await expect(answer(job, execute, "fixture", signal)).rejects.toThrow(
    "budget_exhausted"
  )
  expect(fetch).not.toHaveBeenCalled()
})
