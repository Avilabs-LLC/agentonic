import { afterEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  turnSpec,
  type TurnSpec,
} from "../packages/contracts/src/runtime-protocol"
import { runAgentTurn } from "../packages/runtime/src/agent/turn"
import { RuntimeError } from "../packages/runtime/src/agent/envelope"
import { policy } from "../packages/runtime/src/agent/prompt-loader"
import {
  WEB_RESEARCH_POLICY,
  instructions,
} from "../packages/runtime/src/agent/instructions"
import { WEB_RESEARCH_POLICY as LEGACY_RESEARCH_POLICY } from "../apps/worker/src/web-policy"
import {
  BUDGET_STOP_ANSWER,
  PROPOSAL_ANSWER,
  TurnBroker,
  toolParameters,
} from "../apps/worker/src/broker"
import { runPreview, verifyRuntime } from "../apps/worker/src/runtime"
import type { Execute, Lease } from "../apps/worker/src/pipeline"
import { keyring } from "../packages/connectors/src/secrets"
import { directProviders } from "../apps/worker/src/providers"
// @ts-expect-error untyped build script
import { buildRuntimeArtifact } from "../scripts/runtime-artifact.mjs"

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}))
const sha = (s: string) => createHash("sha256").update(s).digest("hex")
const job: Lease = {
  id: "10000000-0000-4000-8000-000000000001",
  token: "10000000-0000-4000-8000-000000000002",
  kind: "retrieve",
}
const passage = "20000000-0000-4000-8000-000000000001"
const connection = "30000000-0000-4000-8000-000000000001"
const google = {
  clientId: "test",
  clientSecret: "test",
  redirectUri: "http://localhost",
  keys: keyring("a".repeat(64)),
}
const providers = directProviders({
  openaiKey: "synthetic",
  browserbaseKey: "synthetic-web",
  google,
})
const roots: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function envelope(tools: unknown[] = [], passages = true) {
  const config = {
    version: 1,
    systemPrompt: "Speak as a synthetic support assistant.",
    skills: [{ name: "brief", instructions: " Keep answers concise. " }],
  }
  const configurationJson = JSON.stringify(config)
  const assetManifestJson = JSON.stringify([
    { path: "prompts/system.md", sha256: sha(config.systemPrompt) },
    { path: "skills/brief.md", sha256: sha(config.skills[0]!.instructions) },
  ])
  const accessJson = JSON.stringify({
    version: 1,
    collectionIds: [],
    tools,
    collections: [],
  })
  return {
    environment: "staging",
    audience: "private",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
    configurationJson,
    contentSha256: sha(configurationJson),
    composedPromptSha256: sha(policy + "\n\n" + config.systemPrompt),
    assetManifestJson,
    assetManifestSha256: sha(assetManifestJson),
    accessJson,
    accessSha256: sha(accessJson),
    query: "How long is the warranty?",
    history: [{ query: "Hello", answer: "Hi." }],
    passages: passages
      ? [{ id: passage, text: "The synthetic warranty lasts three years." }]
      : [],
  }
}
const WEB = [{ capability: "web", operations: ["web.search", "web.read"] }]
function spec(overrides: Partial<TurnSpec> = {}): TurnSpec {
  const tools = overrides.tools ?? { gmail: [], web: false }
  const toolCalls = tools.web ? 8 : 3
  return turnSpec.parse({
    model: "gpt-4.1-mini-2025-04-14",
    reasoning: null,
    tools,
    limits: { modelCalls: toolCalls + 1, toolCalls, gmailCalls: 3 },
    ...overrides,
  })
}
class Stopped extends Error {}
/** Connects the real runtime loop to the real broker without a process. */
async function turnInProcess(
  turn: TurnSpec,
  execute: Execute,
  options: Partial<ConstructorParameters<typeof TurnBroker>[0]> = {},
  env = envelope(turn.tools.web ? WEB : [])
) {
  const broker = new TurnBroker({
    job,
    execute,
    providers,
    signal: new AbortController().signal,
    turn,
    passageIds: env.passages.map((p) => p.id),
    web: turn.tools.web,
    ...options,
  })
  let id = 0
  const call = async (message: Record<string, unknown>) => {
    const reply = await broker.handle({ ...message, id: ++id })
    if (!reply) throw new Stopped()
    return reply
  }
  try {
    const result = await runAgentTurn(
      { type: "start", envelope: env, turn },
      {
        model: async (r) => (await call({ type: "model", ...r })) as never,
        tool: async (r) => (await call({ type: "tool", ...r })) as never,
      }
    )
    await broker.handle({ type: "result", result })
  } catch (error) {
    if (error instanceof RuntimeError)
      await broker.handle({ type: "error", code: error.code })
    else if (!(error instanceof Stopped)) throw error
  }
  return broker.answer
}
const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { "content-type": "application/json" },
  })
const answer = (value: Record<string, unknown>) => ({
  status: "completed",
  usage: { input_tokens: 10, output_tokens: 10 },
  output: [
    {
      type: "message",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    },
  ],
})
const toolCall = (name: string, args: unknown, callId = name) => ({
  status: "completed",
  usage: { input_tokens: 10, output_tokens: 10 },
  output: [
    {
      type: "function_call",
      name,
      call_id: callId,
      arguments: JSON.stringify(args),
    },
  ],
})
const bodies = (fetch: ReturnType<typeof vi.fn>) =>
  fetch.mock.calls
    .filter(([url]) => String(url).includes("api.openai.com"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)))

describe("runtime-driven turns", () => {
  it("keeps the research words identical to the protocol-1 broker and the policy first", () => {
    expect(WEB_RESEARCH_POLICY).toBe(LEGACY_RESEARCH_POLICY)
    expect(instructions.startsWith(policy)).toBe(true)
    const template = JSON.parse(
      readFileSync("packages/runtime/template.manifest.json", "utf8")
    )
    expect(template.platformPolicyText).toBe(
      readFileSync("packages/runtime/prompts/platform.md", "utf8")
    )
  })
  it("answers from passages through a pinned, metered model call", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json(
        answer({
          text: "Three years.",
          citations: [passage],
          insufficientEvidence: false,
        })
      )
    )
    vi.stubGlobal("fetch", fetch)
    const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
    const recorded = await turnInProcess(spec(), execute)
    expect(recorded).toEqual({
      text: "Three years.",
      citations: [passage],
      insufficientEvidence: false,
      model: "gpt-4.1-mini-2025-04-14",
    })
    expect(execute.mock.calls.map(([op]) => op)).toEqual([
      "reserve",
      "heartbeat",
      "settle",
      "answer",
    ])
    const [body] = bodies(fetch)
    expect(body).toMatchObject({
      model: "gpt-4.1-mini-2025-04-14",
      store: false,
      temperature: 0,
      max_output_tokens: 1000,
    })
    expect(body.tools).toBeUndefined()
    expect(body.input[0]).toEqual({ role: "system", content: instructions })
    expect(body.input[1].content).toBe(
      "Speak as a synthetic support assistant."
    )
    expect(body.text.format.schema.properties.citations.items.enum).toEqual([
      passage,
    ])
  })
  it("runs search → read → answer with contract schemas, broker source links and separate metering", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json(toolCall("web_search", { query: "Browserbase documentation" }))
      )
      .mockResolvedValueOnce(
        json({
          results: [
            { title: "Documentation", url: "https://docs.browserbase.com/" },
          ],
        })
      )
      .mockResolvedValueOnce(
        json(toolCall("web_read", { url: "https://docs.browserbase.com/" }))
      )
      .mockResolvedValueOnce(
        json({
          statusCode: 200,
          contentType: "text/html",
          content: "Public documentation for browser infrastructure.",
        })
      )
      .mockResolvedValueOnce(
        json(
          answer({
            text: "Browserbase provides browser infrastructure.",
            citations: [],
            insufficientEvidence: false,
          })
        )
      )
    vi.stubGlobal("fetch", fetch)
    const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
    const recorded = await turnInProcess(
      spec({ tools: { gmail: [], web: true } }),
      execute
    )
    expect(recorded?.text).toContain(
      "Fuentes web:\n• https://docs.browserbase.com/"
    )
    // Tool evidence is not knowledge-base evidence.
    expect(recorded?.insufficientEvidence).toBe(true)
    const ops = execute.mock.calls.map(([op]) => op)
    expect(ops.filter((op) => op === "web-reserve")).toHaveLength(2)
    expect(ops.filter((op) => op === "reserve")).toHaveLength(3)
    const sent = bodies(fetch)
    expect(sent[0].tools).toEqual([
      {
        type: "function",
        name: "web_search",
        description: expect.any(String),
        parameters: toolParameters({ kind: "web", operation: "web.search" }),
        strict: true,
      },
      {
        type: "function",
        name: "web_read",
        description: expect.any(String),
        parameters: toolParameters({ kind: "web", operation: "web.read" }),
        strict: true,
      },
    ])
    expect(sent[0].tools[0].parameters).toMatchObject({
      type: "object",
      properties: { query: { type: "string", maxLength: 200 } },
      required: ["query"],
      additionalProperties: false,
    })
    expect(sent[0].input).toContainEqual({
      role: "system",
      content: LEGACY_RESEARCH_POLICY,
    })
    // The broker substitutes the provider's own call item into the transcript.
    expect(sent[1].input).toContainEqual({
      type: "function_call",
      name: "web_search",
      call_id: "web_search",
      arguments: JSON.stringify({ query: "Browserbase documentation" }),
    })
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
            return json(
              answer({
                text: "No verified match.",
                citations: [],
                insufficientEvidence: true,
              })
            )
          }
          expect(body.tool_choice).toBe("auto")
          return json(
            toolCall(
              "web_search",
              { query: "refinement " + models },
              "c" + models
            )
          )
        }
        tools++
        return json({ results: [] })
      })
    )
    const recorded = await turnInProcess(
      spec({ tools: { gmail: [], web: true } }),
      vi.fn<Execute>().mockResolvedValue({ ok: true })
    )
    expect(recorded?.text).toBe("No verified match.")
    expect(tools).toBe(8)
    expect(models).toBe(9)
  })
  it("answers from collected evidence after a research timeout without replaying the request", async () => {
    let calls = 0
    vi.spyOn(Date, "now").mockReturnValue(100000)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (++calls === 1) {
          vi.mocked(Date.now).mockReturnValue(165001)
          throw new Error("synthetic timeout")
        }
        expect(JSON.parse(String(init.body)).tool_choice).toBe("none")
        return json(
          answer({
            text: "No verified match.",
            citations: [],
            insufficientEvidence: true,
          })
        )
      })
    )
    const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
    await turnInProcess(spec({ tools: { gmail: [], web: true } }), execute)
    expect(calls).toBe(2)
    const ops = execute.mock.calls.map(([op]) => op)
    expect(ops.filter((op) => op === "reserve")).toHaveLength(2)
    expect(ops.filter((op) => op === "settle")).toHaveLength(1)
  })
  it("records the fixed budget answer itself when research spend runs out", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const execute = vi
      .fn<Execute>()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValue({ ok: true })
    const recorded = await turnInProcess(
      spec({ tools: { gmail: [], web: true } }),
      execute
    )
    expect(recorded?.text).toBe(BUDGET_STOP_ANSWER)
    expect(fetch).not.toHaveBeenCalled()
    expect(execute.mock.calls.map(([op]) => op)).toEqual([
      "reserve",
      "web-check",
      "answer",
    ])
  })
  it("turns a mailbox write into a proposal and ends the turn with the fixed answer", async () => {
    const fetch = vi.fn().mockResolvedValue(
      json(
        toolCall("gmail_send", {
          to: ["synthetic@example.invalid"],
          cc: [],
          bcc: [],
          subject: "Synthetic",
          body: "Synthetic test only",
        })
      )
    )
    vi.stubGlobal("fetch", fetch)
    const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
    const recorded = await turnInProcess(
      spec({ tools: { gmail: ["gmail.send"], web: false } }),
      execute,
      {
        gmail: { connectionId: connection, operations: ["gmail.send"] },
      },
      envelope([{ connectionId: connection, operations: ["gmail.send"] }])
    )
    expect(recorded?.text).toBe(PROPOSAL_ANSWER)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls.map(([op]) => op)).toEqual([
      "reserve",
      "heartbeat",
      "settle",
      "gmail-propose",
      "answer",
    ])
    expect(bodies(fetch)[0].tools[0].parameters).toEqual(
      toolParameters({ kind: "gmail", operation: "gmail.send" })
    )
    expect(JSON.stringify(recorded)).not.toContain("Synthetic test only")
  })
  it("keeps reasoning content in the broker and resends the provider's exact item", async () => {
    const reasoning = {
      type: "reasoning",
      id: "rs_1",
      encrypted_content: "synthetic-encrypted-reasoning",
      summary: [],
    }
    const seen: unknown[] = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      if (!url.includes("api.openai.com"))
        return json({ results: [{ title: "Docs", url: "https://a.example/" }] })
      const body = JSON.parse(String(init.body))
      if (body.input.some((i: { type?: string }) => i.type === "reasoning"))
        return json(
          answer({
            text: "Answered.",
            citations: [],
            insufficientEvidence: true,
          })
        )
      return json({
        ...toolCall("web_search", { query: "docs" }),
        output: [
          reasoning,
          ...toolCall("web_search", { query: "docs" }).output,
        ],
      })
    })
    vi.stubGlobal("fetch", fetch)
    const turn = spec({
      model: "gpt-6-astra",
      reasoning: "high",
      tools: { gmail: [], web: true },
    })
    const broker = new TurnBroker({
      job,
      execute: vi.fn<Execute>().mockResolvedValue({ ok: true }),
      providers,
      signal: new AbortController().signal,
      turn,
      passageIds: [],
      web: true,
    })
    let id = 0
    const result = await runAgentTurn(
      { type: "start", envelope: envelope(WEB, false), turn },
      {
        model: async (r) => {
          const reply = await broker.handle({ type: "model", id: ++id, ...r })
          seen.push(reply)
          return reply as never
        },
        tool: async (r) =>
          (await broker.handle({ type: "tool", id: ++id, ...r })) as never,
      }
    )
    expect(result.text).toBe("Answered.")
    expect(JSON.stringify(seen)).not.toContain("synthetic-encrypted-reasoning")
    const second = bodies(fetch)[1]
    expect(second.input).toContainEqual(reasoning)
    expect(second).toMatchObject({
      model: "gpt-6-astra",
      reasoning: { effort: "high" },
      max_output_tokens: 16384,
      include: ["reasoning.encrypted_content"],
    })
    expect(second.temperature).toBeUndefined()
  })
})

describe("broker refuses what the model did not ask for", () => {
  const request = {
    type: "model",
    id: 1,
    input: [{ role: "user", content: "Synthetic" }],
    tools: [],
    toolChoice: "none",
    format: {
      type: "json_schema",
      name: "agent_preview_answer",
      strict: true,
      schema: { type: "object" },
    },
  }
  const broker = (turn = spec(), options = {}) =>
    new TurnBroker({
      job,
      execute: vi.fn<Execute>().mockResolvedValue({ ok: true }),
      providers,
      signal: new AbortController().signal,
      turn,
      passageIds: [passage],
      web: false,
      ...options,
    })
  it("rejects provider controls, ungranted tools and invented transcript items before spending", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    for (const message of [
      { ...request, model: "gpt-6-astra" },
      { ...request, store: true },
      { ...request, temperature: 1 },
      {
        ...request,
        tools: [{ name: "web_search", description: "x" }],
        toolChoice: "auto",
      },
      {
        ...request,
        tools: [{ name: "gmail_send", description: "x" }],
        toolChoice: "auto",
      },
      { ...request, input: [{ type: "provider", ref: "r1" }] },
      {
        ...request,
        input: [{ type: "function_call_output", call_id: "x", output: "{}" }],
      },
      {
        ...request,
        input: [{ type: "input_image", image_url: "https://a.example/x" }],
      },
    ])
      await expect(broker().handle(message)).rejects.toThrow("runtime_mismatch")
    const gmailOnly = spec({ tools: { gmail: ["gmail.read"], web: false } })
    await expect(
      broker(gmailOnly, {
        gmail: { connectionId: connection, operations: ["gmail.read"] },
      }).handle({
        ...request,
        tools: [{ name: "gmail_send", description: "x" }],
        toolChoice: "auto",
      })
    ).rejects.toThrow("runtime_mismatch")
    expect(fetch).not.toHaveBeenCalled()
  })
  it("executes only a call the model just returned, once", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.includes("api.openai.com")
          ? json(toolCall("web_search", { query: "docs" }, "call_1"))
          : json({ results: [] })
      )
    )
    const b = broker(spec({ tools: { gmail: [], web: true } }), {
      web: true,
    })
    await expect(
      b.handle({ type: "tool", id: 1, callId: "call_1" })
    ).rejects.toThrow("runtime_mismatch")
    const b2 = broker(spec({ tools: { gmail: [], web: true } }), {
      web: true,
    })
    await b2.handle({
      ...request,
      tools: [{ name: "web_search", description: "Find sources." }],
      toolChoice: "auto",
    })
    await expect(
      b2.handle({ type: "tool", id: 2, callId: "invented" })
    ).rejects.toThrow("runtime_mismatch")
    await b2.handle({ type: "tool", id: 3, callId: "call_1" })
    await expect(
      b2.handle({ type: "tool", id: 4, callId: "call_1" })
    ).rejects.toThrow("runtime_mismatch")
  })
  it("never replays a request whose outcome is unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("synthetic transport failure"))
    )
    await expect(broker().handle(request)).rejects.toThrow(
      "provider_unavailable"
    )
    const research = broker(spec({ tools: { gmail: [], web: true } }), {
      web: true,
    })
    const auto = {
      ...request,
      tools: [{ name: "web_search", description: "Find sources." }],
      toolChoice: "auto",
    }
    await expect(research.handle(auto)).resolves.toMatchObject({ ok: false })
    await expect(research.handle({ ...auto, id: 2 })).rejects.toThrow(
      "runtime_mismatch"
    )
  })
  it("enforces the answer invariants and records the pinned model", async () => {
    for (const result of [
      { text: "Guess", citations: [], insufficientEvidence: false },
      {
        text: "Guess",
        citations: ["40000000-0000-4000-8000-000000000001"],
        insufficientEvidence: false,
      },
    ])
      await expect(broker().handle({ type: "result", result })).rejects.toThrow(
        "provider_unavailable"
      )
    await expect(
      broker().handle({ type: "result", result: { text: "x", extra: true } })
    ).rejects.toMatchObject({ diagnostic: "answer_schema_invalid" })
    const b = broker()
    await b.handle({
      type: "result",
      result: {
        text: "Three years.",
        citations: [passage],
        insufficientEvidence: false,
      },
    })
    expect(b.answer?.model).toBe("gpt-4.1-mini-2025-04-14")
    await expect(b.handle({ type: "result", result: {} })).rejects.toThrow(
      "runtime_mismatch"
    )
  })
  it("caps model calls per turn", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          json(answer({ text: "x", citations: [], insufficientEvidence: true }))
        )
    )
    const b = broker(
      turnSpec.parse({
        ...spec(),
        limits: { modelCalls: 1, toolCalls: 3, gmailCalls: 3 },
      })
    )
    await b.handle(request)
    await expect(b.handle({ ...request, id: 2 })).rejects.toThrow(
      "runtime_mismatch"
    )
  })
})

describe("packaged runtime artifact", () => {
  async function artifact() {
    const root = mkdtempSync(join(tmpdir(), "agentonic-runtime-artifact-"))
    roots.push(root)
    return buildRuntimeArtifact({ output: root, gitCommit: "a".repeat(40) })
  }
  const contextFor = (env: ReturnType<typeof envelope>) =>
    vi.fn<Execute>().mockImplementation(async (op) => {
      if (op === "context")
        return { ...env, previewModel: "gpt-4.1-mini-2025-04-14" }
      if (op === "web-tools") return { enabled: true }
      return { ok: true }
    })
  it("builds a reproducible, verified artifact that declares protocol 2", async () => {
    const first = await artifact()
    const second = await artifact()
    expect(second.artifactSha256).toBe(first.artifactSha256)
    expect(first.manifest).toMatchObject({
      previewContract: "1",
      brokerProtocol: "2",
      webResearch: "1",
    })
    const root = join(first.directory, "..")
    expect(
      verifyRuntime(
        {
          manifest: first.manifest,
          artifactSha256: first.artifactSha256,
          gitCommit: first.gitCommit,
        },
        root
      )
    ).toBe(join(first.directory, "src/surfaces/preview.mjs"))
    const bundle = readFileSync(
      join(first.directory, "src/surfaces/preview.mjs"),
      "utf8"
    )
    expect(bundle).not.toMatch(/api\.openai\.com|OPENAI_API_KEY|browserbase/i)
  })
  it("runs a full web turn in the credential-free child process", async () => {
    const built = await artifact()
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        json(toolCall("web_read", { url: "https://docs.browserbase.com/" }))
      )
      .mockResolvedValueOnce(
        json({ statusCode: 200, contentType: "text/html", content: "Docs." })
      )
      .mockResolvedValueOnce(
        json(
          answer({
            text: "Read the docs.",
            citations: [],
            insufficientEvidence: true,
          })
        )
      )
    vi.stubGlobal("fetch", fetch)
    const env = envelope(WEB, false)
    const execute = contextFor(env)
    await runPreview(
      job,
      execute,
      {
        manifest: built.manifest,
        artifactSha256: built.artifactSha256,
        gitCommit: built.gitCommit,
      },
      join(built.directory, ".."),
      directProviders({
        openaiKey: "synthetic-openai",
        browserbaseKey: "synthetic-browserbase",
      }),
      new AbortController().signal
    )
    const recorded = execute.mock.calls.find(([op]) => op === "answer")![2]
    expect(recorded).toEqual({
      text: "Read the docs.\n\nFuentes web:\n• https://docs.browserbase.com/",
      citations: [],
      insufficientEvidence: true,
      model: "gpt-4.1-mini-2025-04-14",
    })
    expect(bodies(fetch)[0].tools.map((t: { name: string }) => t.name)).toEqual(
      ["web_search", "web_read"]
    )
  })
  it("evaluation runs the same artifact without tools", async () => {
    const built = await artifact()
    const fetch = vi
      .fn()
      .mockResolvedValue(
        json(
          answer({
            text: "Three years.",
            citations: [passage],
            insufficientEvidence: false,
          })
        )
      )
    vi.stubGlobal("fetch", fetch)
    const execute = contextFor(envelope(WEB))
    await runPreview(
      job,
      execute,
      {
        manifest: built.manifest,
        artifactSha256: built.artifactSha256,
        gitCommit: built.gitCommit,
      },
      join(built.directory, ".."),
      directProviders({
        openaiKey: "synthetic-openai",
        browserbaseKey: "synthetic-browserbase",
      }),
      new AbortController().signal,
      false
    )
    expect(execute.mock.calls.some(([op]) => op.startsWith("web-"))).toBe(false)
    expect(bodies(fetch)[0].tools).toBeUndefined()
    expect(execute.mock.calls.at(-1)).toEqual([
      "answer",
      job,
      {
        text: "Three years.",
        citations: [passage],
        insufficientEvidence: false,
        model: "gpt-4.1-mini-2025-04-14",
      },
    ])
  })
  it("reports a runtime answer failure with its diagnostic", async () => {
    const built = await artifact()
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json({
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "not json" }],
            },
          ],
        })
      )
    )
    await expect(
      runPreview(
        job,
        contextFor(envelope()),
        {
          manifest: built.manifest,
          artifactSha256: built.artifactSha256,
          gitCommit: built.gitCommit,
        },
        join(built.directory, ".."),
        directProviders({ openaiKey: "synthetic-openai" }),
        new AbortController().signal
      )
    ).rejects.toMatchObject({ diagnostic: "answer_json_invalid" })
  })
})
