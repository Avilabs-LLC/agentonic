import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it } from "vitest"
import {
  digest,
  prepareInstallation,
  switchCurrent,
} from "../apps/worker/src/staging-files"
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "agentonic-install-"))
  roots.push(root)
  const files = {
    "src/surfaces/preview.mjs": "// reviewed synthetic runtime",
    "prompts/platform.md": "Synthetic platform policy",
  }
  const manifest = {
    previewContract: "1",
    model: "gpt-4.1-mini-2025-04-14",
    gitCommit: "a".repeat(40),
    files: Object.fromEntries(
      Object.entries(files).map(([p, v]) => [p, digest(v)])
    ),
  }
  const raw = JSON.stringify(manifest),
    hash = digest(raw),
    runtimeRoot = join(root, "runtime"),
    dir = join(runtimeRoot, hash)
  for (const [p, v] of Object.entries({ ...files, "manifest.json": raw })) {
    mkdirSync(join(dir, p, ".."), { recursive: true })
    writeFileSync(join(dir, p), v)
  }
  const configuration = {
      version: 1 as const,
      systemPrompt: "Synthetic instructions",
      skills: [{ name: "careful", instructions: "Use authorized evidence" }],
    },
    configurationJson = JSON.stringify(configuration)
  const deployment = {
    version: 1,
    deploymentId: "10000000-0000-4000-8000-000000000001",
    workspaceId: "10000000-0000-4000-8000-000000000002",
    agentId: "10000000-0000-4000-8000-000000000003",
    environment: "local",
    approvalId: "10000000-0000-4000-8000-000000000004",
    configurationId: "10000000-0000-4000-8000-000000000005",
    configurationHash: digest(configurationJson),
    accessHash: "b".repeat(64),
    assetHash: "c".repeat(64),
    assets: [
      { path: "prompts/system.md", sha256: digest(configuration.systemPrompt) },
      {
        path: "skills/careful.md",
        sha256: digest(configuration.skills[0]!.instructions),
      },
    ],
    runtime: { gitCommit: manifest.gitCommit, artifactSha256: hash, manifest },
  }
  const manifestJson = JSON.stringify(deployment)
  return {
    root,
    instances: join(root, "instances"),
    runtimeRoot,
    input: {
      manifestJson,
      manifestHash: digest(manifestJson),
      configuration,
      configurationJson,
    },
  }
}
it("materializes only the frozen assets and switches an immutable release atomically", () => {
  const f = fixture(),
    installed = prepareInstallation(f.input, f.instances, f.runtimeRoot)
  expect(
    readFileSync(join(installed.destination, "prompts/system.md"), "utf8")
  ).toBe(f.input.configuration.systemPrompt)
  switchCurrent(f.instances, installed.manifest)
  expect(readlinkSync(join(installed.destination, "../..", "current"))).toBe(
    `releases/${installed.manifest.deploymentId}`
  )
  expect(
    prepareInstallation(f.input, f.instances, f.runtimeRoot).manifestHash
  ).toBe(installed.manifestHash)
})
it("rejects altered customer assets, artifact bytes and mismatched manifests before activation", () => {
  const f = fixture()
  expect(() =>
    prepareInstallation(
      {
        ...f.input,
        configuration: {
          ...f.input.configuration,
          systemPrompt: "Changed draft",
        },
      },
      f.instances,
      f.runtimeRoot
    )
  ).toThrow("runtime_mismatch")
  expect(() =>
    prepareInstallation(
      { ...f.input, manifestHash: "f".repeat(64) },
      f.instances,
      f.runtimeRoot
    )
  ).toThrow("runtime_mismatch")
  const manifest = JSON.parse(f.input.manifestJson)
  writeFileSync(
    join(
      f.runtimeRoot,
      manifest.runtime.artifactSha256,
      "src/surfaces/preview.mjs"
    ),
    "// tampered"
  )
  expect(() =>
    prepareInstallation(f.input, f.instances, f.runtimeRoot)
  ).toThrow("runtime_mismatch")
})
it("rejects path traversal in generated skills and never overwrites another frozen release", () => {
  const f = fixture()
  expect(() =>
    prepareInstallation(
      {
        ...f.input,
        configuration: {
          ...f.input.configuration,
          skills: [{ name: "../../outside", instructions: "bad" }],
        },
      },
      f.instances,
      f.runtimeRoot
    )
  ).toThrow()
  const installed = prepareInstallation(f.input, f.instances, f.runtimeRoot)
  chmodSync(join(installed.destination, "prompts/system.md"), 0o600)
  writeFileSync(join(installed.destination, "prompts/system.md"), "tampered")
  expect(() =>
    prepareInstallation(f.input, f.instances, f.runtimeRoot)
  ).toThrow("immutable_release")
})
