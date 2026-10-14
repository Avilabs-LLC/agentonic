import { bootstrapConfig, loadLocal, connect, fail } from "./local-config.mjs"
let db
try {
  const { e } = bootstrapConfig()
  db = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  // Extension installation is platform bootstrap; application DDL stays in Prisma.
  const exists = await db.query(
    "SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'"
  )
  if (exists.rowCount && exists.rows[0].nspname !== "public")
    throw new Error("Unexpected vector namespace; review migration first")
  await db.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")
  await db.end()
  db = null
  if (process.argv.includes("--budget")) {
    const env = loadLocal("apps/worker/.env.local"),
      migration = loadLocal(".env.database.local")
    db = await connect(
      migration.AGENTONIC_MIGRATION_DATABASE_URL,
      migration.AGENTONIC_DATABASE_CA_FILE
    )
    // The most each provider's total cap may be: the owner authorized up to
    // US$100 for OpenAI on 14 October 2026 (§78), US$25 before.
    for (const [provider, variable, ceiling] of [
      ["voyage", "AGENTONIC_VOYAGE_SPEND_CAP_USD", 25],
      ["openai", "AGENTONIC_OPENAI_RAG_SPEND_CAP_USD", 100],
    ]) {
      const cap = Number(env[variable] ?? 0)
      if (!Number.isFinite(cap) || cap < 0 || cap > ceiling)
        throw new Error(
          `Set the explicitly authorized provider cap between 0 and ${ceiling} USD`
        )
      await db.query(
        "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=$1,updated_at=clock_timestamp() WHERE provider=$2",
        [Math.floor(cap * 1_000_000), provider]
      )
    }
    console.log(
      "Provider caps synchronized without resetting accumulated usage."
    )
  } else
    console.log(
      "pgvector prepared. Apply Prisma migrations before configuring the provider budget."
    )
} catch (error) {
  fail(error)
} finally {
  await db?.end()
}
