import { execFileSync } from "node:child_process"
import { join, resolve } from "node:path"
import { root } from "./local-config.mjs"
import { buildRuntimeArtifact } from "./runtime-artifact.mjs"
// Packages packages/runtime from a clean, committed checkout so the recorded
// commit describes every bundled byte. Never package uncommitted changes.
const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  })
    .toString()
    .trim()
if (git("status", "--porcelain"))
  throw new Error("Commit reviewed changes before packaging the runtime")
const packaged = await buildRuntimeArtifact({
  output: resolve(process.argv[2] ?? join(root, ".local/runtime")),
  gitCommit: git("rev-parse", "HEAD"),
})
console.log(
  JSON.stringify({
    artifactSha256: packaged.artifactSha256,
    gitCommit: packaged.gitCommit,
    directory: packaged.directory,
  })
)
