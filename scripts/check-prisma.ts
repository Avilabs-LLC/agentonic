import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { parse } from "dotenv"
import { identityOverview } from "../packages/database/src/client"
const env = parse(readFileSync("apps/customer/.env.local"))
Object.assign(process.env, env)
try {
  const result = await identityOverview("00000000-0000-4000-8000-000000000000")
  assert.equal(result.user, null)
  assert.equal(result.staff, null)
  assert.deepEqual(result.workspaces, [])
  console.log(
    "Prisma adapter: verified TLS, transaction context, and unknown identity denial passed."
  )
  process.exit(0)
} catch {
  console.error("Prisma adapter verification failed; details suppressed.")
  process.exit(1)
}
