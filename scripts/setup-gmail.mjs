import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import { loadLocal, writeLocal, root, fail } from "./local-config.mjs"
try {
  const source =
    process.argv.find((v) => v.startsWith("--source-root="))?.slice(14) ?? root
  const credentials = loadLocal(resolve(source, ".env.staging.local"))
  if (!credentials.GOOGLE_CLIENT_ID || !credentials.GOOGLE_CLIENT_SECRET)
    throw new Error("Missing Google configuration")
  // Create once and preserve. Losing this key requires reconnecting accounts.
  credentials.AGENTONIC_CONNECTION_KEY ??= randomBytes(32).toString("hex")
  credentials.GOOGLE_REDIRECT_URI ??=
    "http://localhost:3101/api/connections/google/callback"
  writeLocal(resolve(source, ".env.staging.local"), credentials)
  for (const target of ["apps/customer/.env.local", "apps/worker/.env.local"]) {
    const customer = loadLocal(resolve(source, target))
    for (const name of [
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "GOOGLE_REDIRECT_URI",
      "AGENTONIC_CONNECTION_KEY",
      // Present only while a key rotation is under way (rotate-connection-key.mjs).
      "AGENTONIC_CONNECTION_STANDBY_KEYS",
      // Google's Picker for Drive (§62); only the customer app opens it.
      ...(target.startsWith("apps/customer")
        ? ["GOOGLE_PICKER_API_KEY", "GOOGLE_CLOUD_PROJECT_NUMBER"]
        : []),
    ])
      if (credentials[name]) customer[name] = credentials[name]
      else delete customer[name]
    writeLocal(resolve(source, target), customer)
  }
  console.log(
    "Google configuration copied to protected customer and preview worker environments. Restart the customer app and preview worker to load it. No account connected, no mailbox or Drive accessed."
  )
} catch (e) {
  fail(e)
}
