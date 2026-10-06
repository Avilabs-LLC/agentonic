import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { root } from "./local-config.mjs"
import { describeTree, releaseId } from "./platform-tree.mjs"
// Assembles the platform release from a clean CI checkout after both apps were
// built (architecture §53): the Admin and customer standalone servers and the
// knowledge worker, with a manifest naming every file. Run by the release
// workflow; never builds the apps itself.
const require = createRequire(import.meta.url)
const { build } = require("esbuild")
const sha = (value) => createHash("sha256").update(value).digest("hex")
const out = join(root, "dist/platform")
rmSync(out, { recursive: true, force: true })
const tree = join(out, "tree")
mkdirSync(tree, { recursive: true })

// Each app's traced server, plus the static files the standalone output leaves out.
for (const app of ["admin", "customer"]) {
  const built = join(root, "apps", app, ".next")
  assert.ok(
    existsSync(join(built, "standalone/apps", app, "server.js")),
    `Build ${app} with output: "standalone" first`
  )
  cpSync(join(built, "standalone"), join(tree, app), {
    recursive: true,
    verbatimSymlinks: true,
  })
  cpSync(join(built, "static"), join(tree, app, "apps", app, ".next/static"), {
    recursive: true,
  })
  // Development settings never travel: the release's configuration comes from the host.
  for (const name of [".env", ".env.local", ".env.production"])
    rmSync(join(tree, app, "apps", app, name), { force: true })
}

// The knowledge worker: one bundle, the isolated PDF parser beside it (it is
// forked by path), the PDF engine's worker file, and the native canvas package
// the PDF engine needs on Linux.
const worker = join(tree, "worker")
await build({
  entryPoints: {
    worker: join(root, "apps/worker/src/main.ts"),
    "pdf-parser": join(root, "apps/worker/src/pdf-parser.mjs"),
  },
  outdir: worker,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: ["pg-native", "@napi-rs/canvas"],
  logLevel: "warning",
  banner: {
    js: 'import { createRequire as _createRequire } from "node:module"; const require = _createRequire(import.meta.url);',
  },
})
const fromWorker = createRequire(join(root, "apps/worker/package.json"))
const pdfParse = createRequire(fromWorker.resolve("pdf-parse/package.json"))
cpSync(
  join(
    dirname(pdfParse.resolve("pdfjs-dist/package.json")),
    "legacy/build/pdf.worker.mjs"
  ),
  join(worker, "pdf.worker.mjs")
)
const canvasRoot = dirname(pdfParse.resolve("@napi-rs/canvas/package.json"))
const canvas = JSON.parse(readFileSync(join(canvasRoot, "package.json")))
const fromCanvas = createRequire(join(canvasRoot, "package.json"))
const natives = Object.keys(canvas.optionalDependencies ?? {}).filter(
  (name) => {
    try {
      fromCanvas.resolve(`${name}/package.json`)
      return true
    } catch {
      return false
    }
  }
)
assert.equal(natives.length, 1, "Expected exactly one installed canvas binary")
for (const name of ["@napi-rs/canvas", ...natives])
  cpSync(
    dirname(fromCanvas.resolve(`${name}/package.json`)),
    join(worker, "node_modules", name),
    { recursive: true, dereference: true }
  )

const git = (...args) =>
  execFileSync("git", args, { cwd: root }).toString().trim()
assert.equal(git("status", "--porcelain"), "", "Package a clean checkout")
const { files, links } = describeTree(tree)
const manifest = {
  version: 1,
  platform: JSON.parse(readFileSync(join(root, "package.json"))).version,
  commit: git("rev-parse", "HEAD"),
  lockfileSha256: sha(readFileSync(join(root, "pnpm-lock.yaml"))),
  // The worker's native canvas binary ties the release to one OS and CPU.
  target: `${process.platform}-${process.arch}`,
  node: process.version,
  // Migrations this release expects the database to have applied.
  migrations: readdirSync(join(root, "packages/database/prisma/migrations"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(),
  programs: {
    admin: "admin/apps/admin/server.js",
    customer: "customer/apps/customer/server.js",
    worker: "worker/worker.mjs",
  },
  files,
  links,
}
for (const program of Object.values(manifest.programs))
  assert.ok(files[program], `Missing ${program}`)
const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n")
writeFileSync(join(out, "manifest.json"), bytes)
execFileSync("tar", ["-czf", join(out, "platform.tar.gz"), "-C", tree, "."])
const id = releaseId(bytes)
writeFileSync(
  join(out, "release.json"),
  JSON.stringify(
    {
      releaseId: id,
      platform: manifest.platform,
      commit: manifest.commit,
      target: manifest.target,
      archiveSha256: sha(readFileSync(join(out, "platform.tar.gz"))),
      files: Object.keys(files).length,
      links: Object.keys(links).length,
    },
    null,
    2
  ) + "\n"
)
rmSync(tree, { recursive: true })
console.log(readFileSync(join(out, "release.json"), "utf8"))
