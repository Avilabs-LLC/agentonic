import { createHash } from "node:crypto"
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { join, relative } from "node:path"
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.name.startsWith(".") || entry.name === "node_modules"
      ? []
      : entry.isDirectory()
        ? files(join(dir, entry.name))
        : [join(dir, entry.name)]
  )
}
function hash(paths) {
  const hash = createHash("sha256")
  for (const path of [...paths].sort())
    hash.update(path).update(readFileSync(path))
  return hash.digest("hex")
}
const shared = files("packages/ui/src").filter((p) => /\.(tsx?|css)$/.test(p))
const next = { version: 1, routes: {} }
const missing = []
for (const app of ["admin", "customer"]) {
  const appRoot = `apps/${app}`
  const all = files(appRoot)
  for (const page of all.filter((p) => p.endsWith("/page.tsx"))) {
    const dir = page.slice(0, -"/page.tsx".length)
    const loading = join(dir, "loading.tsx")
    if (!existsSync(loading)) {
      missing.push(loading)
      continue
    }
    const sources = all.filter(
      (p) =>
        /\.(tsx?|css)$/.test(p) &&
        !p.endsWith("/loading.tsx") &&
        !p.includes("/api/") &&
        !p.includes("next-env")
    )
    // Conservative transitive coverage: a change to any app/shared visual source requires review.
    next.routes[relative(".", page)] = {
      source: hash([...sources, ...shared]),
      skeleton: hash([
        loading,
        ...shared.filter((p) => p.includes("skeleton")),
      ]),
    }
  }
}
if (missing.length) {
  console.error("Missing skeletons:", missing.join(", "))
  process.exit(1)
}
const manifest = "scripts/skeleton-manifest.json"
if (process.argv[2] === "update") {
  writeFileSync(manifest, JSON.stringify(next, null, 2) + "\n")
  console.log("Skeleton review baseline updated.")
} else {
  const old = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, "utf8"))
    : null
  if (JSON.stringify(old) !== JSON.stringify(next)) {
    console.error(
      "Skeleton review required. Review affected pages/loading states, then run pnpm skeletons:update."
    )
    process.exit(1)
  }
  console.log(
    `${Object.keys(next.routes).length} routes have current skeleton review baselines.`
  )
}
