import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const root = new URL("../", import.meta.url)
const read = (path) => readFileSync(new URL(path, root), "utf8")
const write = (path, value) => writeFileSync(new URL(path, root), value)
const packageJson = JSON.parse(read("package.json"))
const version = packageJson.version
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
if (!match)
  throw new Error("Expected a stable major.minor.patch package version.")

const historyPath = "lib/version-history.ts"
const historyPrefix = "export const VERSION_HISTORY = "
const historySource = read(historyPath).trim()
if (
  !historySource.startsWith(historyPrefix) ||
  !historySource.endsWith(" as const")
) {
  throw new Error("Unexpected version history format.")
}
const history = JSON.parse(
  historySource.slice(historyPrefix.length, -" as const".length)
)
if (!Array.isArray(history) || history[0]?.version !== version) {
  throw new Error("Version history does not match package.json.")
}
if (
  read("lib/app-version.ts") !== `export const APP_VERSION = "${version}"\n` ||
  !read("packages/ui/src/lib/version.ts").includes(
    `export const APP_VERSION_LABEL = "v${version}"`
  )
) {
  throw new Error("Application version metadata is out of sync.")
}

const args = process.argv.slice(2)
if (args.length === 1 && args[0] === "check") {
  console.log(`Version ${version}: package, application, UI and history agree.`)
} else if (
  args.length === 4 &&
  args[0] === "bump" &&
  args[1] === "branch" &&
  args[2] === "--summary" &&
  args[3].trim()
) {
  const next = `${Number(match[1])}.${Number(match[2]) + 1}.0`
  packageJson.version = next
  history.unshift({
    version: next,
    date: new Date().toISOString().slice(0, 10),
    summary: args[3].trim(),
  })
  write("package.json", JSON.stringify(packageJson, null, 2) + "\n")
  write("lib/app-version.ts", `export const APP_VERSION = "${next}"\n`)
  write(
    historyPath,
    historyPrefix + JSON.stringify(history, null, 2) + " as const\n"
  )
  write(
    "packages/ui/src/lib/version.ts",
    read("packages/ui/src/lib/version.ts").replace(
      `export const APP_VERSION_LABEL = "v${version}"`,
      `export const APP_VERSION_LABEL = "v${next}"`
    )
  )
  console.log(`Branch release ${version} → ${next} in ${fileURLToPath(root)}`)
  console.log(
    "Review the changed version label, then refresh the skeleton baseline before committing."
  )
} else {
  throw new Error(
    'Usage: node scripts/versioning.mjs check | bump branch --summary "Release summary"'
  )
}
