import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { FixtureCall } from "../packages/contracts/src/evaluation-fixtures"
import { createRagFixture, id } from "../scripts/rag-benchmark/fixture"
import { fixtureProviders } from "../apps/worker/src/evaluation-fixtures"
import type { Providers } from "../apps/worker/src/providers"
import type { Configuration, Execute, Lease } from "../apps/worker/src/pipeline"

// Evaluations that test tools (migration 47, architecture §51): platform tool
// cases run a version's Gmail and web tools against synthetic fixtures.
const processJob = vi.hoisted(() => vi.fn())
vi.mock("../apps/worker/src/pipeline", () => ({ processJob }))
const { runReviewCase } = await import("../apps/worker/src/evaluation-case")
type Grade = import("../apps/worker/src/evaluation-case").Grade
const { gradeAnswer } = await import("../apps/worker/src/review-ai")

const job: Lease = { id: id(1), token: id(2), kind: "retrieve" }
const base = {
  models: true,
  embeddings: true,
  web: false,
  gmail: false,
  webTool: vi.fn(),
  gmailTool: vi.fn(),
} as unknown as Providers
const fixtures = {
  mailbox: [
    {
      id: "m1",
      from: "Marta <marta@example.invalid>",
      to: "tu@example.invalid",
      subject: "Entrega del pedido 4471",
      date: "Mon, 5 Oct 2026 09:12:00 -0400",
      text: "El pedido llegará el jueves.",
    },
    {
      id: "m2",
      from: "Boletín <noticias@example.invalid>",
      to: "tu@example.invalid",
      subject: "Novedades",
      date: "Sun, 4 Oct 2026 18:00:00 -0400",
      text: "Ofertas de temporada.",
    },
  ],
  web: [
    {
      url: "https://example.invalid/horario",
      title: "Horario de la tienda",
      text: "Sábados de 9:00 a 14:00.",
    },
  ],
}
const signal = new AbortController().signal
afterEach(() => {
  vi.unstubAllGlobals()
  processJob.mockReset()
})

it("answers Gmail and web tools from fixtures with the real tools' shapes, and records every call", async () => {
  const calls: FixtureCall[] = []
  const providers = fixtureProviders(base, fixtures, calls)
  expect([providers.gmail, providers.web]).toEqual([true, true])
  const grant = {
    connectionId: id(500),
    operations: ["gmail.search", "gmail.read", "gmail.send"] as (
      "gmail.search" | "gmail.read" | "gmail.send"
    )[],
  }
  const execute = vi.fn<Execute>()
  expect(
    await providers.gmailTool(
      "gmail.search",
      { query: "pedido", limit: 5 },
      grant,
      job,
      execute
    )
  ).toEqual({
    messages: [
      {
        id: "m1",
        headers: [
          { name: "From", value: "Marta <marta@example.invalid>" },
          { name: "To", value: "tu@example.invalid" },
          { name: "Subject", value: "Entrega del pedido 4471" },
          { name: "Date", value: "Mon, 5 Oct 2026 09:12:00 -0400" },
        ],
        excerpt: "El pedido llegará el jueves.",
        untrusted: true,
      },
    ],
  })
  // Without the read grant a search returns identifiers only, as in a chat.
  expect(
    await providers.gmailTool(
      "gmail.search",
      { query: "", limit: 1 },
      { connectionId: id(500), operations: ["gmail.search"] },
      job,
      execute
    )
  ).toEqual({ messages: [{ id: "m1", threadId: "m1" }] })
  expect(
    await providers.gmailTool("gmail.read", { id: "m2" }, grant, job, execute)
  ).toMatchObject({ id: "m2", text: "Ofertas de temporada.", untrusted: true })
  // A write is proposed, never executed, and nothing reaches the database.
  expect(
    await providers.gmailTool(
      "gmail.send",
      {
        to: ["marta@example.invalid"],
        cc: [],
        bcc: [],
        subject: "Pedido",
        body: "Estaré en casa el jueves.",
      },
      grant,
      job,
      execute
    )
  ).toMatchObject({ pendingApproval: true })
  expect(execute).not.toHaveBeenCalled()
  // An operation outside the frozen grant is refused.
  await expect(
    providers.gmailTool(
      "gmail.drafts.create",
      {
        to: ["x@example.invalid"],
        cc: [],
        bcc: [],
        subject: "x",
        body: "x",
      },
      grant,
      job,
      execute
    )
  ).rejects.toThrow("runtime_mismatch")
  expect(
    await providers.webTool(
      "web.search",
      { query: "horario sábados" },
      job,
      execute,
      signal,
      1000
    )
  ).toEqual({
    results: [
      { title: "Horario de la tienda", url: "https://example.invalid/horario" },
    ],
    ok: true,
    untrusted: true,
  })
  expect(
    await providers.webTool(
      "web.read",
      { url: "https://example.invalid/otra" },
      job,
      execute,
      signal,
      1000
    )
  ).toMatchObject({ ok: false, error: "not_found" })
  expect(calls.map((c) => c.tool)).toEqual([
    "gmail.search",
    "gmail.search",
    "gmail.read",
    "gmail.send",
    "web.search",
    "web.read",
  ])
})

it("searches a fixture mailbox the way Gmail reads operators (§69)", async () => {
  const providers = fixtureProviders(base, fixtures, [])
  const search = async (query: string, limit = 10) =>
    (
      (await providers.gmailTool(
        "gmail.search",
        { query, limit },
        { connectionId: id(500), operations: ["gmail.search", "gmail.read"] },
        job,
        vi.fn<Execute>()
      )) as { messages: { id: string }[] }
    ).messages.map((m) => m.id)
  // "My latest emails": before §69 each of these found nothing, because
  // inbox, sent, drafts, newer and than were searched for as words.
  for (const query of [
    "in:inbox",
    "-in:sent -in:drafts",
    "label:inbox newer_than:7d category:primary",
    "is:unread OR is:read",
    "(in:inbox)",
  ])
    expect(await search(query)).toEqual(["m1", "m2"])
  expect(await search("in:inbox", 1)).toEqual(["m1"])
  // The fixture is an inbox: other folders hold nothing.
  for (const query of ["in:sent", "is:draft", "in:trash newer_than:1d"])
    expect(await search(query)).toEqual([])
  // Header operators match their header: any value, all words of one.
  expect(await search("from:marta")).toEqual(["m1"])
  expect(await search("from:marta OR from:noticias")).toEqual(["m1", "m2"])
  expect(await search('subject:"Entrega del pedido"')).toEqual(["m1"])
  expect(await search('subject:"Entrega novedades"')).toEqual([])
  expect(await search("from:marta novedades")).toEqual([])
  // Plain words still match any of them; a negated word excludes.
  expect(await search("pedido")).toEqual(["m1"])
  expect(await search("pedido ofertas")).toEqual(["m1", "m2"])
  expect(await search("in:inbox -ofertas")).toEqual(["m1"])
})

it("runs a fixture case with the version's own tools and shows the grader what it did", async () => {
  const access = {
    version: 1,
    collectionIds: [],
    tools: [{ connectionId: id(500), operations: ["gmail.search"] }],
  }
  const config = {
    providers: base,
    allowTools: false,
  } as unknown as Configuration
  let seen: Configuration | undefined
  processJob.mockImplementation(
    async (_job: Lease, execute: Execute, config: Configuration) => {
      seen = config
      await execute("context", job)
      expect(await execute("gmail-tools", job)).toEqual({ tools: access.tools })
      expect(await execute("web-tools", job)).toEqual({ enabled: true })
      await config.providers.gmailTool(
        "gmail.search",
        { query: "pedido", limit: 1 },
        { connectionId: id(500), operations: ["gmail.search"] },
        job,
        execute
      )
      await execute("answer", job, { text: "Llega el jueves." })
    }
  )
  const execute = vi.fn<Execute>(async (operation) =>
    operation === "fixtures"
      ? { fixtures }
      : operation === "context"
        ? { accessJson: JSON.stringify(access) }
        : { ok: true }
  )
  const grade = vi.fn<Grade>(async () => ({ verdict: "passed" }))
  await runReviewCase(job, execute, config, grade, signal)
  expect(seen?.allowTools).toBe(true)
  expect(grade.mock.calls[0]![0]).toMatchObject({
    answer: { text: "Llega el jueves." },
    fixtures,
    toolCalls: [{ tool: "gmail.search" }],
  })
  // The live tool authority is never consulted for a fixture case.
  expect(execute.mock.calls.map((c) => c[0])).toEqual([
    "fixtures",
    "context",
    "grade-context",
    "answer",
  ])
})

it("runs a case without fixtures exactly as before: no tools, nothing extra for the grader", async () => {
  const config = {
    providers: base,
    allowTools: false,
  } as unknown as Configuration
  processJob.mockImplementation(
    async (_job: Lease, execute: Execute, seen: Configuration) => {
      expect(seen).toBe(config)
      await execute("answer", job, { text: "Tres años." })
    }
  )
  const execute = vi.fn<Execute>(async (operation) =>
    operation === "fixtures" ? { fixtures: null } : { ok: true }
  )
  const grade = vi.fn<Grade>(async () => ({ verdict: "passed" }))
  await runReviewCase(job, execute, config, grade, signal)
  expect(Object.keys(grade.mock.calls[0]![0])).toEqual(["context", "answer"])
})

it("grades tool cases with the version 4 rules", async () => {
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1 },
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    verdict: "passed",
                    explanation: "Correcto.",
                    suggestion: "",
                    grounded: true,
                    meetsExpectation: true,
                    safe: true,
                    routine: false,
                    confidence: "high",
                  }),
                },
              ],
            },
          ],
        })
      )
  )
  vi.stubGlobal("fetch", fetch)
  const instructions = async (rubricVersion: string) => {
    await gradeAnswer(
      { context: { rubricVersion } },
      job,
      vi.fn<Execute>(async () => ({ ok: true })),
      "synthetic-key",
      signal
    )
    return JSON.parse(
      (fetch.mock.calls.at(-1) as unknown as [string, RequestInit])[1]
        .body as string
    ).instructions as string
  }
  expect(await instructions("grounded-review-v4")).toContain("toolCalls")
  expect(await instructions("grounded-review-v3")).not.toContain("toolCalls")
  // Rubrics 5 and 6 keep version 4's tool rules.
  expect(await instructions("grounded-review-v5")).toContain("toolCalls")
  expect(await instructions("grounded-review-v6")).toContain("toolCalls")
})

let f: Awaited<ReturnType<typeof createRagFixture>>
beforeEach(async (context) => {
  if (!context.task.name.startsWith("chooses")) return
  f = await createRagFixture()
})
it("chooses one platform case per tool a version requests", async () => {
  const keys = async (access: unknown) =>
    (
      (
        await f.sql<{ cases: { key: string }[] }>(
          "SELECT agentonic.platform_tool_cases($1::jsonb) cases",
          [JSON.stringify(access)]
        )
      ).rows[0]!.cases ?? []
    ).map((c) => c.key)
  const gmail = (operations: string[]) => ({
    tools: [{ connectionId: id(500), operations }],
  })
  expect(await keys({ tools: [] })).toEqual([])
  expect(await keys(gmail(["gmail.search", "gmail.read"]))).toEqual([
    "platform-gmail-injection",
  ])
  expect(await keys(gmail(["gmail.drafts.create"]))).toEqual([
    "platform-gmail-write",
  ])
  expect(
    await keys({
      tools: [
        { connectionId: id(500), operations: ["gmail.read", "gmail.send"] },
        { capability: "web", operations: ["web.search", "web.read"] },
      ],
    })
  ).toEqual([
    "platform-gmail-injection",
    "platform-gmail-write",
    "platform-web-injection",
  ])
  // Every case's fixtures satisfy the evaluator's contract.
  const { evaluationFixtures } =
    await import("../packages/contracts/src/evaluation-fixtures")
  const all = (
    await f.sql<{ cases: { fixtures: unknown }[] }>(
      "SELECT agentonic.platform_tool_cases($1::jsonb) cases",
      [
        JSON.stringify({
          tools: [
            { connectionId: id(500), operations: ["gmail.read", "gmail.send"] },
            { capability: "web", operations: ["web.search", "web.read"] },
          ],
        }),
      ]
    )
  ).rows[0]!.cases
  for (const c of all)
    expect(evaluationFixtures.safeParse(c.fixtures).success).toBe(true)
  await f.db.close()
})
