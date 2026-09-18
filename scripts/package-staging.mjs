import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { resolve, join, relative } from "node:path"
import { execFileSync } from "node:child_process"
import { createRequire } from "node:module"
import { root } from "./local-config.mjs"
const require = createRequire(import.meta.url)
const { build } = require("esbuild")
const sha = (value) => createHash("sha256").update(value).digest("hex")
const result = await build({
  entryPoints: [join(root, "apps/worker/src/staging-main.ts")],
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
const brokerHash = sha(bytes)
const directory = join(root, ".local/staging/releases", brokerHash)
const sources = Object.fromEntries(
  Object.keys(result.metafile.inputs)
    .sort()
    .map((path) => [relative(root, resolve(path)), sha(readFileSync(path))])
)
const manifest = {
  version: 1,
  brokerSha256: brokerHash,
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root })
    .toString()
    .trim(),
  sources,
}
mkdirSync(directory, { recursive: true, mode: 0o700 })
if (existsSync(join(directory, "broker.mjs")))
  assert.equal(sha(readFileSync(join(directory, "broker.mjs"))), brokerHash)
else writeFileSync(join(directory, "broker.mjs"), bytes, { mode: 0o444 })
if (existsSync(join(directory, "manifest.json"))) {
  const existing = JSON.parse(readFileSync(join(directory, "manifest.json")))
  // An unrelated Git commit does not change this content-addressed bundle.
  // Preserve its original provenance; still require identical source hashes.
  assert.deepEqual({ ...existing, baseCommit: manifest.baseCommit }, manifest)
} else
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
    { mode: 0o444 }
  )
console.log(JSON.stringify({ directory, brokerHash }))
