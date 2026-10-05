import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
// @ts-expect-error -- plain ESM script without type declarations
import { recordRelease } from "../scripts/release-files.mjs"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

it("treats identical bundle bytes from different sources as the same release", () => {
  const directory = join(mkdtempSync(join(tmpdir(), "agentonic-release-")), "r")
  roots.push(join(directory, ".."))
  const manifest = (sources: Record<string, string>, baseCommit = "a") => ({
    version: 1,
    workerSha256: "w",
    baseCommit,
    sources,
  })
  const bytes = Buffer.from("// reviewed bundle")
  expect(
    recordRelease({
      directory,
      program: "worker.mjs",
      bytes,
      manifest: manifest({ x: "1" }),
    })
  ).toMatchObject({ sourcesChanged: false })
  // A comment-only source change: same bytes, recorded provenance kept, rebuild reported.
  expect(
    recordRelease({
      directory,
      program: "worker.mjs",
      bytes,
      manifest: manifest({ x: "2" }, "b"),
    })
  ).toMatchObject({ sourcesChanged: true })
  expect(
    JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))
  ).toMatchObject({
    baseCommit: "a",
    sources: { x: "1" },
  })
  expect(() =>
    recordRelease({
      directory,
      program: "worker.mjs",
      bytes: Buffer.from("// other bytes"),
      manifest: manifest({ x: "1" }),
    })
  ).toThrow("Release bytes changed")
  expect(() =>
    recordRelease({
      directory,
      program: "worker.mjs",
      bytes,
      manifest: { ...manifest({ x: "1" }), workerSha256: "other" },
    })
  ).toThrow("Release identity changed")
})
