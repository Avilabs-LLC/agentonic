import { afterEach, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verifyRuntime, generatePreview } from "../apps/worker/src/runtime"
import type { Execute, Lease } from "../apps/worker/src/pipeline"
const roots: string[] = []
const model = "gpt-4.1-mini-2025-04-14"
const job: Lease = {
  id: "10000000-0000-4000-8000-000000000001",
  token: "10000000-0000-4000-8000-000000000002",
  kind: "retrieve",
}
const request = {
  model,
  store: false,
  temperature: 0,
  max_output_tokens: 1000,
  input: [{ role: "user", content: "Synthetic question" }],
  text: { format: {} },
}
afterEach(() => {
  vi.unstubAllGlobals()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
it("verifies every installed executable byte and rejects altered or substituted artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "agentonic-preview-test-"))
  roots.push(root)
  const sha = (x: string) => createHash("sha256").update(x).digest("hex")
  const manifest = {
    previewContract: "1",
    model,
    gitCommit: "a".repeat(40),
    files: {
      "src/surfaces/preview.mjs": sha("// synthetic"),
      "prompts/platform.md": sha("policy"),
    },
  }
  const raw = JSON.stringify(manifest),
    artifactSha256 = sha(raw),
    directory = join(root, artifactSha256)
  mkdirSync(join(directory, "src/surfaces"), { recursive: true })
  mkdirSync(join(directory, "prompts"))
  writeFileSync(join(directory, "manifest.json"), raw)
  writeFileSync(join(directory, "src/surfaces/preview.mjs"), "// synthetic")
  writeFileSync(join(directory, "prompts/platform.md"), "policy")
  const envelope = { manifest, artifactSha256, gitCommit: manifest.gitCommit }
  expect(verifyRuntime(envelope, root)).toBe(
    join(directory, "src/surfaces/preview.mjs")
  )
  writeFileSync(join(directory, "src/surfaces/preview.mjs"), "// altered")
  expect(() => verifyRuntime(envelope, root)).toThrow("runtime_mismatch")
  expect(() =>
    verifyRuntime({ ...envelope, artifactSha256: "../../file" }, root)
  ).toThrow()
})
it("blocks model controls or tools and insufficient budget before making a provider call", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  const execute = vi.fn<Execute>().mockResolvedValue({ ok: false })
  for (const body of [
    { ...request, tools: [{ type: "web_search" }] },
    { ...request, store: true },
    { ...request, model: "other" },
  ])
    await expect(
      generatePreview(
        body,
        job,
        execute,
        "fixture",
        new AbortController().signal
      )
    ).rejects.toThrow()
  expect(execute).not.toHaveBeenCalled()
  await expect(
    generatePreview(
      request,
      job,
      execute,
      "fixture",
      new AbortController().signal
    )
  ).rejects.toThrow("budget_exhausted")
  expect(fetch).not.toHaveBeenCalled()
})
it("reserves before generation and settles actual usage; retains unknown reservations", async () => {
  const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
  const fetch = vi.fn().mockResolvedValue(
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
                text: "Evidence missing.",
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
    request,
    job,
    execute,
    "fixture",
    new AbortController().signal
  )
  expect(execute.mock.calls.map((c) => c[0])).toEqual([
    "reserve",
    "heartbeat",
    "settle",
  ])
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toMatchObject({
    store: false,
    max_output_tokens: 1000,
    text: { format: { type: "json_schema", strict: true } },
  })
  execute.mockClear()
  fetch.mockRejectedValue(new Error("unknown transport outcome"))
  await expect(
    generatePreview(
      request,
      job,
      execute,
      "fixture",
      new AbortController().signal
    )
  ).rejects.toThrow("provider_unavailable")
  expect(execute.mock.calls.map((c) => c[0])).toEqual(["reserve", "heartbeat"])
})

it("Gmail model calls are bounded and metered, and write tools only persist a proposal", async () => {
  const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      status: "completed",
      usage: { input_tokens: 80, output_tokens: 30 },
      output: [
        {
          type: "function_call",
          name: "gmail_send",
          call_id: "call_synthetic",
          arguments: JSON.stringify({
            to: ["synthetic@example.invalid"],
            cc: [],
            bcc: [],
            subject: "Synthetic",
            body: "Synthetic test only",
          }),
        },
      ],
    })
  )
  vi.stubGlobal("fetch", fetch)
  const result = await generatePreview(
    request,
    job,
    execute,
    "fixture",
    new AbortController().signal,
    {
      grant: { connectionId: job.id, operations: ["gmail.send"] },
      config: {
        clientId: "test",
        clientSecret: "test",
        encryptionKey: "a".repeat(64),
        redirectUri: "http://localhost",
      },
    }
  )
  expect(result).toMatchObject({ insufficientEvidence: true })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(execute.mock.calls.map((c) => c[0])).toEqual([
    "reserve",
    "heartbeat",
    "settle",
    "gmail-propose",
  ])
  const sent = JSON.parse(fetch.mock.calls[0]![1].body)
  expect(sent.parallel_tool_calls).toBe(false)
  expect(sent.tools.map((t: { name: string }) => t.name)).toEqual([
    "gmail_send",
  ])
  expect(JSON.stringify(result)).not.toContain("Synthetic test only")
})
it("rejects a model request for an ungranted Gmail operation after settling provider usage", async () => {
  const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        status: "completed",
        usage: { input_tokens: 80, output_tokens: 30 },
        output: [
          {
            type: "function_call",
            name: "gmail_send",
            call_id: "call_synthetic",
            arguments: "{}",
          },
        ],
      })
    )
  )
  await expect(
    generatePreview(
      request,
      job,
      execute,
      "fixture",
      new AbortController().signal,
      {
        grant: { connectionId: job.id, operations: ["gmail.read"] },
        config: {
          clientId: "test",
          clientSecret: "test",
          encryptionKey: "a".repeat(64),
          redirectUri: "http://localhost",
        },
      }
    )
  ).rejects.toThrow("runtime_mismatch")
  expect(execute.mock.calls.map((c) => c[0])).toEqual([
    "reserve",
    "heartbeat",
    "settle",
  ])
})
it("derives KB citation coverage after a successful Gmail read instead of rejecting a mailbox answer", async () => {
  const { seal } = await import("../packages/connectors/src/secrets")
  const encryptionKey = "a".repeat(64)
  const execute = vi.fn<Execute>().mockImplementation(async (op) =>
    op === "gmail-read"
      ? {
          credential: seal(
            { refreshToken: "synthetic" },
            `gmail:${job.id}`,
            encryptionKey
          ),
          account: "synthetic@example.invalid",
        }
      : { ok: true }
  )
  const final = {
    status: "completed",
    usage: { input_tokens: 80, output_tokens: 30 },
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              text: "Synthetic email subject",
              citations: [],
              insufficientEvidence: false,
            }),
          },
        ],
      },
    ],
  }
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        status: "completed",
        usage: { input_tokens: 80, output_tokens: 30 },
        output: [
          {
            type: "function_call",
            name: "gmail_read",
            call_id: "read_1",
            arguments: JSON.stringify({ id: "abc123" }),
          },
        ],
      })
    )
    .mockResolvedValueOnce(
      Response.json({ access_token: "synthetic", expires_in: 3600 })
    )
    .mockResolvedValueOnce(
      Response.json({
        id: "abc123",
        payload: {
          mimeType: "text/plain",
          body: {
            data: Buffer.from("Synthetic email subject").toString("base64url"),
          },
        },
      })
    )
    .mockResolvedValueOnce(Response.json(final))
  vi.stubGlobal("fetch", fetch)
  const result = await generatePreview(
    request,
    job,
    execute,
    "fixture",
    new AbortController().signal,
    {
      grant: { connectionId: job.id, operations: ["gmail.read"] },
      config: {
        clientId: "test",
        clientSecret: "test",
        encryptionKey,
        redirectUri: "http://localhost",
      },
    }
  )
  expect(result).toEqual({
    text: "Synthetic email subject",
    citations: [],
    insufficientEvidence: true,
  })
  expect(execute.mock.calls.filter((c) => c[0] === "settle")).toHaveLength(2)
  // Merely enabling Gmail must not make unsupported answers pass grounding.
  fetch.mockResolvedValueOnce(Response.json(final))
  expect(
    await generatePreview(
      request,
      job,
      execute,
      "fixture",
      new AbortController().signal,
      {
        grant: { connectionId: job.id, operations: ["gmail.read"] },
        config: {
          clientId: "test",
          clientSecret: "test",
          encryptionKey,
          redirectUri: "http://localhost",
        },
      }
    )
  ).toMatchObject({ insufficientEvidence: false })
})
it("constrains mailbox-only output to no KB citations and rejects fabricated document IDs", async () => {
  const execute = vi.fn<Execute>().mockResolvedValue({ ok: true })
  const answer = (citations: string[]) =>
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
                text: "Synthetic summary",
                citations,
                insufficientEvidence: true,
              }),
            },
          ],
        },
      ],
    })
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(answer([]))
    .mockResolvedValueOnce(answer([job.id]))
    .mockResolvedValueOnce(answer([job.token]))
    .mockResolvedValueOnce(answer(["abc0"]))
  vi.stubGlobal("fetch", fetch)
  await generatePreview(
    request,
    job,
    execute,
    "fixture",
    new AbortController().signal,
    undefined,
    []
  )
  const empty = JSON.parse(fetch.mock.calls[0]![1].body).text.format.schema
    .properties
  expect(empty.citations.maxItems).toBe(0)
  expect(empty.insufficientEvidence.enum).toEqual([true])
  await generatePreview(
    request,
    job,
    execute,
    "fixture",
    new AbortController().signal,
    undefined,
    [job.id]
  )
  expect(
    JSON.parse(fetch.mock.calls[1]![1].body).text.format.schema.properties
      .citations.items.enum
  ).toEqual([job.id])
  await expect(
    generatePreview(
      request,
      job,
      execute,
      "fixture",
      new AbortController().signal,
      undefined,
      [job.id]
    )
  ).rejects.toMatchObject({ diagnostic: "answer_citations_invalid" })
  await expect(
    generatePreview(
      request,
      job,
      execute,
      "fixture",
      new AbortController().signal,
      undefined,
      []
    )
  ).rejects.toMatchObject({ diagnostic: "answer_citations_invalid" })
})
