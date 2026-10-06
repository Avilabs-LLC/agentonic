import { readdirSync, readFileSync } from "node:fs"
import { beforeAll, expect, it } from "vitest"
import { createRagFixture } from "../scripts/rag-benchmark/fixture"

// Facts the documentation states about the code. They drifted before (the
// README said 28 tables long after there were more); these keep them current.
const read = (path: string) => readFileSync(path, "utf8")
const migrations = readdirSync("packages/database/prisma/migrations").filter(
  (name) => /^\d/.test(name)
).length
const target = read("docs/schema.dbml").match(/^Table agentonic\./gm)!.length
const latest = Math.max(
  ...[...read("docs/agentonic-architecture.md").matchAll(/^## (\d+)\./gm)].map(
    (m) => Number(m[1])
  )
)
let built = 0
beforeAll(async () => {
  const f = await createRagFixture()
  const r = await f.sql<{ n: number }>(
    "SELECT count(*)::int n FROM information_schema.tables WHERE table_type='BASE TABLE' AND table_schema='agentonic'"
  )
  built = r.rows[0]!.n
  await f.db.close()
})

it("current-state gives the table and migration counts", () => {
  expect(read("docs/current-state.md")).toContain(
    `describes ${target} tables; ${built} exist in the ${migrations} checked-in migrations.`
  )
})

it("the README gives the table count and the checkpoint range", () => {
  const readme = read("README.md")
  expect(readme).toContain(`${built} of its ${target} tables exist so far`)
  expect(readme).toContain(`(§§22–${latest})`)
})

it("current-state points to the latest architecture section", () => {
  expect(read("docs/current-state.md")).toMatch(
    new RegExp(`\\| §${latest} +\\|`)
  )
})

it("current-state names the platform version", () => {
  const { version } = JSON.parse(read("package.json")) as { version: string }
  expect(read("docs/current-state.md")).toContain(`platform v${version}`)
})
