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
