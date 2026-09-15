import { readFileSync } from "node:fs"
import { bootstrapConfig, connect, fail } from "./local-config.mjs"
let client
try {
  const { e } = bootstrapConfig()
  client = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  await client.query("BEGIN")
  await client.query(
    readFileSync(
      new URL("./sql/review-identity-boundary.sql", import.meta.url),
      "utf8"
    )
  )
  await client.query("COMMIT")
  console.log(
    "Migration-only review identity bridge prepared. Prisma owns the staff read boundary."
  )
} catch (error) {
  await client?.query("ROLLBACK")
  fail(error)
} finally {
  await client?.end()
}
