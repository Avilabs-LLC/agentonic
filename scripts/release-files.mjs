import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { isDeepStrictEqual } from "node:util"
import { join } from "node:path"
const sha = (value) => createHash("sha256").update(value).digest("hex")

/**
 * Records a content-addressed program release. The bundle bytes name the release, so a
 * rebuild that yields the same bytes from different sources (a comment, an unbundled
 * change) is the same release: the first build's manifest stays its provenance record
 * and the rebuild is reported, not refused. Different bytes under a recorded name are refused.
 */
export function recordRelease({ directory, program, bytes, manifest }) {
  const hash = sha(bytes)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const programPath = join(directory, program)
  if (existsSync(programPath))
    assert.equal(sha(readFileSync(programPath)), hash, "Release bytes changed")
  else writeFileSync(programPath, bytes, { mode: 0o444 })
  const manifestPath = join(directory, "manifest.json")
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o444,
    })
    return { hash, sourcesChanged: false }
  }
  const existing = JSON.parse(readFileSync(manifestPath, "utf8"))
  // Same release: everything but the build's provenance (commit and source hashes) matches.
  const identity = (value) => {
    const rest = { ...value }
    delete rest.baseCommit
    delete rest.sources
    return rest
  }
  assert.deepEqual(
    identity(existing),
    identity(manifest),
    "Release identity changed"
  )
  return {
    hash,
    sourcesChanged: !isDeepStrictEqual(existing.sources, manifest.sources),
  }
}
