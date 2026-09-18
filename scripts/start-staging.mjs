import assert from "node:assert/strict"
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { root } from "./local-config.mjs"
const installation = JSON.parse(
  readFileSync(join(root, ".local/staging/local-installation.json"))
)
const pidFile = join(root, ".local/staging/manager.pid")
let alive = false
if (existsSync(pidFile)) {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), 0)
    alive = true
  } catch {
    // A stale PID file can be replaced after the prior controller exits.
  }
}
assert.ok(!alive, "Local staging controller already running")
const child = spawn(
  process.execPath,
  [join(installation.release, "broker.mjs"), "--manager"],
  {
    env: {
      PATH: process.env.PATH,
      AGENTONIC_STAGING_CONFIG: installation.config,
    },
    stdio: "inherit",
  }
)
child.once("spawn", () =>
  writeFileSync(pidFile, String(child.pid), { mode: 0o600 })
)
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal))
child.once("exit", (code) => {
  if (
    existsSync(pidFile) &&
    readFileSync(pidFile, "utf8") === String(child.pid)
  )
    unlinkSync(pidFile)
  process.exitCode = code ?? 1
})
