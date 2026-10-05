import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve, join, relative } from "node:path"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { root } from "./local-config.mjs"
import { recordRelease } from "./release-files.mjs"
const require = createRequire(import.meta.url)
const { build } = require("esbuild")
const sha = (value) => createHash("sha256").update(value).digest("hex")
const result = await build({
  entryPoints: [join(root, "apps/worker/src/evaluation-main.ts")],
  bundle: true,
  write: false,
  metafile: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["pg-native"],
  banner: {
    js: 'import { createRequire as _createRequire } from "node:module"; const require = _createRequire(import.meta.url);',
  },
})
const bytes = result.outputFiles[0].contents
const workerHash = sha(bytes)
const directory = join(root, ".local/evaluation/releases", workerHash)
const sources = Object.fromEntries(
  Object.keys(result.metafile.inputs)
    .sort()
    .map((path) => [relative(root, resolve(path)), sha(readFileSync(path))])
)
const manifest = {
  version: 1,
  workerSha256: workerHash,
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim(),
  sources,
}
const { sourcesChanged } = recordRelease({
  directory,
  program: "worker.mjs",
  bytes,
  manifest,
})
console.log(JSON.stringify({ directory, workerHash, sourcesChanged }))
