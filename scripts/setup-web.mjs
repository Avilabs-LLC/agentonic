import {
  loadLocal,
  writeLocal,
  bootstrapConfig,
  connect,
  fail,
} from "./local-config.mjs"
// Operator-only setup. Does not reset accumulated usage or change VM services.
let db
try {
  const source = loadLocal(".env.staging.local")
  if (!source.BROWSERBASE_API_KEY)
    throw new Error("Browserbase configuration required")
  const worker = loadLocal("apps/worker/.env.local")
  worker.BROWSERBASE_API_KEY = source.BROWSERBASE_API_KEY
  writeLocal("apps/worker/.env.local", worker)
  const { e, ref } = bootstrapConfig()
  if (ref !== "jkgdxkacariasunhentd")
    throw new Error("Configured nonproduction project required")
  const cap = Number(
    process.argv.find((a) => a.startsWith("--cap-usd="))?.slice(10) ?? "1"
  )
  if (!Number.isFinite(cap) || cap <= 0 || cap > 25)
    throw new Error("A bounded development cap is required")
  db = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  await db.query(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=greatest(cap_microusd,$1),updated_at=clock_timestamp() WHERE provider='browserbase'",
    [Math.ceil(cap * 1000000)]
  )
  console.log(
    "Browserbase configured for the local preview worker; usage history preserved. Restart the worker to load the protected key."
  )
} catch (error) {
  fail(error)
} finally {
  await db?.end()
}
