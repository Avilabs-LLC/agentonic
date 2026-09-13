import { spawn } from "node:child_process"
import { loadLocal, fail } from "./local-config.mjs"
import { postgresTlsBridge } from "./postgres-tls-bridge.mjs"
try {
  const e = loadLocal(".env.database.local")
  const url = new URL(e.AGENTONIC_MIGRATION_DATABASE_URL)
  if (!decodeURIComponent(url.username).startsWith("agentonic_migrator."))
    throw new Error("Migration role required.")
  const bridge = await postgresTlsBridge(url, e.AGENTONIC_DATABASE_CA_FILE)
  try {
    // Plain PostgreSQL exists only on this process-local loopback connection. The
    // bridge refuses unverified TLS to the real host; it never downgrades transport.
    url.hostname = "127.0.0.1"
    url.port = String(bridge.port)
    url.search = "?schema=agentonic&sslmode=disable&connect_timeout=15"
    const child = spawn(
      "pnpm",
      [
        "--filter",
        "@agentonic/database",
        "exec",
        "prisma",
        "migrate",
        "deploy",
      ],
      {
        env: {
          ...process.env,
          AGENTONIC_MIGRATION_DATABASE_URL: url.toString(),
          RUST_LOG: "info",
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    let output = ""
    child.stdout.on("data", (data) => {
      output += data
    })
    child.stderr.on("data", (data) => {
      output += data
    })
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject)
      child.on("close", resolve)
    })
    if (code !== 0) {
      console.error(
        "Migration failed:",
        output.match(/\bP\d{4}\b/)?.[0] ??
          (bridge.failed() ? "TLS_CONNECTION_FAILED" : "CHECK_MIGRATION")
      )
      process.exitCode = 1
    } else
      console.log(
        "Prisma migrations applied with the dedicated migration role and verified remote TLS."
      )
  } finally {
    await bridge.close()
  }
} catch (error) {
  fail(error)
}
