import { createRequire } from "node:module"
import { createHash } from "node:crypto"
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  existsSync,
  rmSync,
  chmodSync,
} from "node:fs"
import { join, resolve } from "node:path"
const require = createRequire(import.meta.url)
const { build } = require("esbuild")
const root = resolve(import.meta.dirname, "..")
const sha = (value) => createHash("sha256").update(value).digest("hex")
export const runtimeVersion = () =>
  JSON.parse(readFileSync(join(root, "packages/runtime/package.json"), "utf8"))
    .version

// Builds the immutable, content-addressed runtime artifact: one bundled Node 22
// entry point plus the platform policy, described by a checksummed manifest.
// Paths inside the bundle are relative to the repository root, so the same
// commit produces the same bytes from any checkout.
export async function buildRuntimeArtifact({ output, gitCommit }) {
  if (!/^[a-f0-9]{40}$/.test(gitCommit)) throw new Error("Commit required")
  const source = join(root, "packages/runtime")
  mkdirSync(output, { recursive: true })
  const temporary = mkdtempSync(join(output, ".building-"))
  try {
    const entry = "src/surfaces/preview.mjs"
    await build({
      absWorkingDir: root,
      entryPoints: [join(source, "src/surfaces/preview.ts")],
      outfile: join(temporary, entry),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      legalComments: "none",
      logLevel: "silent",
    })
    mkdirSync(join(temporary, "prompts"), { recursive: true })
    writeFileSync(
      join(temporary, "prompts/platform.md"),
      readFileSync(join(source, "prompts/platform.md"))
    )
    const files = Object.fromEntries(
      [entry, "prompts/platform.md"].map((f) => [
        f,
        sha(readFileSync(join(temporary, f))),
      ])
    )
    const manifest = {
      previewContract: "1",
      brokerProtocol: "2",
      gmailContract: "1",
      webContract: "1",
      webResearch: "1",
      model: "gpt-4.1-mini-2025-04-14",
      gitCommit,
      files,
    }
    const raw = JSON.stringify(manifest, null, 2) + "\n"
    const artifactSha256 = sha(raw)
    writeFileSync(join(temporary, "manifest.json"), raw)
    const directory = join(output, artifactSha256)
    if (!existsSync(directory)) {
      for (const f of [...Object.keys(files), "manifest.json"])
        chmodSync(join(temporary, f), 0o444)
      renameSync(temporary, directory)
    }
    return { artifactSha256, gitCommit, directory, manifest }
  } finally {
    if (existsSync(temporary))
      rmSync(temporary, { recursive: true, force: true })
  }
}
