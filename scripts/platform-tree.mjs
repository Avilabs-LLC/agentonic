// Describes and verifies a platform release tree (architecture §53). Uses only
// node: built-ins: the installer sends this file to the VM, which checks the
// unpacked release with it before installing, so the check never comes from
// the release it is checking.
import { createHash } from "node:crypto"
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs"
import { join, posix } from "node:path"

const sha = (value) => createHash("sha256").update(value).digest("hex")

/** Every regular file's SHA-256 and every link's target, by relative path. */
export function describeTree(directory) {
  const files = {},
    links = {}
  const walk = (relative) => {
    const names = readdirSync(join(directory, relative)).sort()
    for (const name of names) {
      const path = relative ? `${relative}/${name}` : name
      const stat = lstatSync(join(directory, path))
      if (stat.isDirectory()) walk(path)
      else if (stat.isFile())
        files[path] = sha(readFileSync(join(directory, path)))
      else if (stat.isSymbolicLink()) {
        const target = readlinkSync(join(directory, path))
        const resolved = posix.normalize(
          posix.join(posix.dirname(path), target)
        )
        if (target.startsWith("/") || resolved.startsWith(".."))
          throw new Error(`Link leaves the release: ${path}`)
        links[path] = target
      } else throw new Error(`Unexpected file type: ${path}`)
    }
  }
  walk("")
  return { files, links }
}

/** What differs between a tree and its manifest; empty when they match exactly. */
export function treeProblems(directory, manifest) {
  const actual = describeTree(directory)
  const problems = []
  for (const kind of ["files", "links"]) {
    const expected = manifest[kind] ?? {}
    for (const [path, value] of Object.entries(expected))
      if (!(path in actual[kind])) problems.push(`missing ${path}`)
      else if (actual[kind][path] !== value) problems.push(`changed ${path}`)
    for (const path of Object.keys(actual[kind]))
      if (!(path in expected)) problems.push(`unexpected ${path}`)
  }
  return problems
}

/** A release is named by its manifest's bytes. */
export const releaseId = (manifestBytes) => sha(manifestBytes)
