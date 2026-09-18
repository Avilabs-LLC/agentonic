import { afterEach, expect, it, vi } from "vitest"
import {
  browserbaseClient,
  publicAddress,
  publicWebUrl,
  readWeb,
  searchWeb,
} from "../packages/connectors/src/browserbase"
import { executeWeb } from "../apps/worker/src/web"
import type { Execute, Lease } from "../apps/worker/src/pipeline"
import { generatePreview } from "../apps/worker/src/runtime"
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}))
const job: Lease = {
  id: "10000000-0000-4000-8000-000000000001",
  token: "10000000-0000-4000-8000-000000000002",
  kind: "retrieve",
}
const signal = new AbortController().signal
const response = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it("rejects private destinations, credentials, non-HTTPS, special hosts and nonpublic DNS addresses", () => {
  for (const url of [
    "http://www.browserbase.com",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://localhost/",
    "https://metadata.internal/",
    "https://a.local/",
    "https://127.0.0.1.nip.io/",
    "https://user:pass@www.browserbase.com/",
    "https://www.browserbase.com:8443/",
    "https://www.browserbase.com./",
  ])
    expect(() => publicWebUrl(url)).toThrow()
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2001:db8::1",
  ])
    expect(publicAddress(ip)).toBe(false)
  expect(publicAddress("93.184.216.34")).toBe(true)
  expect(publicWebUrl("https://www.browserbase.com/#section")).toBe(
    "https://www.browserbase.com/"
  )
})
it("uses bounded read-only SDK requests without cookies, proxies or redirects and truncates content", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response({
        results: [
          { title: "Public", url: "https://www.browserbase.com/" },
          { title: "Private", url: "http://localhost/" },
        ],
      })
    )
    .mockResolvedValueOnce(
      response({
        statusCode: 200,
        contentType: "text/html",
        content: "x".repeat(17000),
      })
    )
  vi.stubGlobal("fetch", fetch)
  const client = browserbaseClient("synthetic")
  expect(await searchWeb(client, "public docs", signal)).toEqual([
    { title: "Public", url: "https://www.browserbase.com/" },
  ])
  const read = await readWeb(client, "https://www.browserbase.com/", signal)
  expect(read.text).toHaveLength(16000)
  expect(read.truncated).toBe(true)
  expect(JSON.parse(fetch.mock.calls[1]![1].body)).toEqual({
    url: "https://www.browserbase.com/",
    format: "markdown",
    allowRedirects: false,
    allowInsecureSsl: false,
    proxies: false,
  })
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({
    query: "public docs",
    numResults: 5,
  })
})
it("rejects redirects, PDFs and provider failures without retrying", async () => {
  const fetch = vi.fn().mockResolvedValue(
    response({
      statusCode: 302,
      contentType: "text/html",
      content: "redirect",
    })
  )
  vi.stubGlobal("fetch", fetch)
  const client = browserbaseClient("synthetic")
  await expect(
    readWeb(client, "https://www.browserbase.com/", signal)
  ).rejects.toThrow()
  expect(fetch).toHaveBeenCalledTimes(1)
})
it("returns a bounded budget stop before contacting Browserbase", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  const execute = vi
    .fn<Execute>()
    .mockResolvedValue({ ok: false, code: "budget_exhausted" })
  await expect(
    executeWeb(
      "web.search",
      { query: "public docs" },
      job,
      execute,
      "synthetic",
      signal
    )
  ).resolves.toMatchObject({ ok: false, error: "budget_exhausted", stop: true })
  expect(fetch).not.toHaveBeenCalled()
  expect(execute).toHaveBeenCalledWith(
    "web-reserve",
    job,
    expect.objectContaining({ operation: "web.search" })
  )
})
it("does not offer web tools without the broker-authorized capability", async () => {
  const fetch = vi.fn().mockResolvedValue(
    response({
      status: "completed",
      usage: { input_tokens: 1, output_tokens: 1 },
      output: [
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: JSON.stringify({
                text: "No web access.",
                citations: [],
                insufficientEvidence: true,
              }),
            },
          ],
        },
      ],
    })
  )
  vi.stubGlobal("fetch", fetch)
  await generatePreview(
    {
      model: "gpt-4.1-mini-2025-04-14",
      store: false,
      temperature: 0,
      max_output_tokens: 1000,
      input: [{ role: "user", content: "Search the web" }],
      text: { format: {} },
    },
    job,
    vi.fn<Execute>().mockResolvedValue({ ok: true }),
    "synthetic",
    signal,
    undefined,
    []
  )
  expect(JSON.parse(fetch.mock.calls[0]![1].body).tools).toBeUndefined()
})
it("completes search → read → answer with verified source links and separate metering", async () => {
  const calls = (name: string, args: unknown) => ({
    status: "completed",
    usage: { input_tokens: 10, output_tokens: 10 },
    output: [
      {
        type: "function_call",
        name,
        call_id: name,
        arguments: JSON.stringify(args),
      },
    ],
  })
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response(calls("web_search", { query: "Browserbase documentation" }))
    )
    .mockResolvedValueOnce(
      response({
        results: [
          { title: "Documentation", url: "https://docs.browserbase.com/" },
        ],
      })
    )
    .mockResolvedValueOnce(
      response(calls("web_read", { url: "https://docs.browserbase.com/" }))
    )
    .mockResolvedValueOnce(
      response({
        statusCode: 200,
        contentType: "text/html",
        content: "Public documentation for browser infrastructure.",
      })
    )
    .mockResolvedValueOnce(
      response({
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 10 },
        output: [
          {
            type: "message",
            content: [
              {
                type: "output_text",
                text: JSON.stringify({
                  text: "Browserbase provides browser infrastructure.",
                  citations: [],
                  insufficientEvidence: true,
                }),
              },
            ],
          },
        ],
      })
    )
  vi.stubGlobal("fetch", fetch)
  const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
  const answer = await generatePreview(
    {
      model: "gpt-4.1-mini-2025-04-14",
      store: false,
      temperature: 0,
      max_output_tokens: 1000,
      input: [{ role: "user", content: "What is Browserbase?" }],
      text: { format: {} },
    },
    job,
    execute,
    "synthetic-openai",
    signal,
    undefined,
    [],
    "synthetic-browserbase"
  )
  expect(answer.text).toContain("Fuentes web:\n• https://docs.browserbase.com/")
  expect(answer.citations).toEqual([])
  expect(
    execute.mock.calls.filter(([op]) => op === "web-reserve")
  ).toHaveLength(2)
  expect(execute.mock.calls.filter(([op]) => op === "web-settle")).toHaveLength(
    2
  )
  expect(execute.mock.calls.filter(([op]) => op === "reserve")).toHaveLength(3)
  expect(fetch).toHaveBeenCalledTimes(5)
  expect(
    JSON.parse(fetch.mock.calls[0]![1].body).tools.map(
      (t: { name: string }) => t.name
    )
  ).toEqual(["web_search", "web_read"])
})
it("retains reservations and returns a recoverable provider error without replay", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(new Response("Unavailable", { status: 503 }))
  vi.stubGlobal("fetch", fetch)
  const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
  await expect(
    executeWeb(
      "web.search",
      { query: "public docs" },
      job,
      execute,
      "synthetic",
      signal
    )
  ).resolves.toMatchObject({
    ok: false,
    error: "provider_http_error",
    stop: false,
  })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(execute.mock.calls.map(([op]) => op)).toEqual([
    "web-reserve",
    "web-check",
    "web-check",
  ])
})

it.each([
  [302, "text/html", "moved", "redirect"],
  [403, "text/html", "denied", "page_http_error"],
  [429, "text/html", "limited", "rate_limit"],
  [200, "application/pdf", "binary", "unsupported_content"],
  [200, "text/html", "", "empty_content"],
])(
  "classifies page failure %s / %s without leaking content",
  async (statusCode, contentType, content, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ statusCode, contentType, content }))
    )
    const log = vi.spyOn(console, "info").mockImplementation(() => {})
    const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
    expect(
      await executeWeb(
        "web.read",
        { url: "https://example.com/private-query?secret=synthetic" },
        job,
        execute,
        "synthetic",
        signal
      )
    ).toMatchObject({ ok: false, error: code })
    expect(execute.mock.calls.some(([op]) => op === "web-settle")).toBe(false)
    const logged = JSON.parse(log.mock.calls[0]![0])
    expect(logged).toEqual({
      event: "web_tool_unavailable",
      job: job.id,
      operation: "web.read",
      code,
      ...(statusCode >= 300 ? { status: statusCode } : {}),
    })
  }
)
it("does not downgrade authorization loss during an unreadable page to a tool result", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("Unavailable", { status: 503 }))
  )
  const execute = vi
    .fn<Execute>()
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: true })
    .mockRejectedValueOnce(new Error("lease_lost"))
  await expect(
    executeWeb(
      "web.search",
      { query: "public docs" },
      job,
      execute,
      "synthetic",
      signal
    )
  ).rejects.toThrow("lease_lost")
})
const modelCall = (name: string, args: unknown) => ({
  status: "completed",
  usage: { input_tokens: 10, output_tokens: 10 },
  output: [
    {
      type: "function_call",
      name,
      call_id: name,
      arguments: JSON.stringify(args),
    },
  ],
})
const modelAnswer = () => ({
  status: "completed",
  usage: { input_tokens: 10, output_tokens: 10 },
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: JSON.stringify({
            text: "No verified match.",
            citations: [],
            insufficientEvidence: true,
          }),
        },
      ],
    },
  ],
})
const modelRequest = {
  model: "gpt-4.1-mini-2025-04-14",
  store: false,
  temperature: 0,
  max_output_tokens: 1000,
  input: [{ role: "user", content: "Find a home matching every criterion" }],
  text: { format: {} },
}
it("recovers from an unreadable page, suppresses duplicate retries and continues to a verified source", async () => {
  const modelRequests: Record<string, unknown>[] = []
  let step = 0,
    reads = 0
  vi.spyOn(console, "info").mockImplementation(() => {})
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("api.openai.com")) {
        modelRequests.push(JSON.parse(String(init.body)))
        return response(
          step++ < 2
            ? modelCall("web_read", { url: "https://example.com/blocked" })
            : step === 3
              ? modelCall("web_read", { url: "https://example.com/verified" })
              : modelAnswer()
        )
      }
      reads++
      const args = JSON.parse(String(init.body))
      return response({
        statusCode: args.url.endsWith("blocked") ? 403 : 200,
        contentType: "text/html",
        content: "Evidence",
      })
    })
  )
  const answer = await generatePreview(
    modelRequest,
    job,
    vi.fn<Execute>().mockResolvedValue({ ok: true }),
    "synthetic",
    signal,
    undefined,
    [],
    "synthetic",
    8
  )
  expect(reads).toBe(2)
  expect(JSON.stringify(modelRequests[1])).toContain("page_http_error")
  expect(JSON.stringify(modelRequests[2])).toContain("already_failed")
  expect(answer.text).toContain("https://example.com/verified")
  expect(answer.text).not.toContain("https://example.com/blocked")
})
it("allows eight research calls then forces an honest final answer", async () => {
  let tools = 0,
    models = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("api.openai.com")) {
        models++
        const body = JSON.parse(String(init.body))
        if (models === 9) {
          expect(body.tool_choice).toBe("none")
          return response(modelAnswer())
        }
        expect(body.tool_choice).toBe("auto")
        return response(
          modelCall("web_search", { query: "refinement " + models })
        )
      }
      tools++
      return response({ results: [] })
    })
  )
  await generatePreview(
    modelRequest,
    job,
    vi.fn<Execute>().mockResolvedValue({ ok: true }),
    "synthetic",
    signal,
    undefined,
    [],
    "synthetic",
    8
  )
  expect(tools).toBe(8)
  expect(models).toBe(9)
})
it("reserves a final-answer phase when the research deadline has elapsed", async () => {
  let models = 0
  vi.spyOn(Date, "now").mockReturnValue(100000)
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes("api.openai.com")) {
        models++
        if (models === 1) {
          vi.mocked(Date.now).mockReturnValue(165001)
          return response(modelCall("web_search", { query: "public docs" }))
        }
        expect(JSON.parse(String(init.body)).tool_choice).toBe("none")
        return response(modelAnswer())
      }
      throw new Error("Must not start a provider request after the deadline")
    })
  )
  await generatePreview(
    modelRequest,
    job,
    vi.fn<Execute>().mockResolvedValue({ ok: true }),
    "synthetic",
    signal,
    undefined,
    [],
    "synthetic",
    8
  )
  expect(models).toBe(2)
})

it("reports exhausted model budget without another provider request", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  const execute = vi
    .fn<Execute>()
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: true })
  const answer = await generatePreview(
    modelRequest,
    job,
    execute,
    "synthetic",
    signal,
    undefined,
    [],
    "synthetic",
    8
  )
  expect(answer.text).toContain("presupuesto disponible")
  expect(fetch).not.toHaveBeenCalled()
  expect(execute.mock.calls.map(([op]) => op)).toEqual(["reserve", "web-check"])
})
it("uses only the final-answer phase after a research model timeout and retains its reservation", async () => {
  let calls = 0
  vi.spyOn(Date, "now").mockReturnValue(100000)
  const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      if (++calls === 1) {
        vi.mocked(Date.now).mockReturnValue(165001)
        throw new Error("synthetic timeout")
      }
      expect(JSON.parse(String(init.body)).tool_choice).toBe("none")
      return response(modelAnswer())
    })
  )
  await generatePreview(
    modelRequest,
    job,
    execute,
    "synthetic",
    signal,
    undefined,
    [],
    "synthetic",
    8
  )
  expect(calls).toBe(2)
  expect(execute.mock.calls.filter(([op]) => op === "reserve")).toHaveLength(2)
  expect(execute.mock.calls.filter(([op]) => op === "settle")).toHaveLength(1)
})
