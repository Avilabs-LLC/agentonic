import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { loadLocal, writeLocal, connect, fail } from "./local-config.mjs"
import { connectionKeys } from "../packages/connectors/src/secrets.ts"
import {
  KEY_FILES,
  activateKey,
  addKey,
  describeKeys,
  keyUsage,
  rekey,
  retireKeys,
  sameKeys,
} from "./connection-keys.mjs"
// Replaces the connection key in four steps (see connection-keys.mjs). Prints
// key names and counts only, never keys or stored values.
const step = process.argv[2]
const reload =
  "Restart the customer app and the worker, and reinstall each staging host with install-staging, before the next step."
let db
try {
  const files = Object.fromEntries(
    KEY_FILES.map((file) => [file, loadLocal(file)])
  )
  const envs = Object.values(files)
  assert.ok(
    sameKeys(envs),
    `${KEY_FILES.join(", ")} hold different keys; align them before rotating`
  )
  const current = describeKeys(envs[0])
  const write = (change) => {
    for (const [file, env] of Object.entries(files))
      writeLocal(file, change(env))
  }
  const database = async () => {
    const migration = loadLocal(".env.database.local")
    db = await connect(
      migration.AGENTONIC_MIGRATION_DATABASE_URL,
      migration.AGENTONIC_DATABASE_CA_FILE
    )
    return (text, values) => db.query(text, values)
  }
  if (step === "status") {
    const stored = await keyUsage(await database())
    console.log(JSON.stringify({ keys: current, stored }, null, 2))
  } else if (step === "add") {
    assert.equal(
      current.standby.length,
      0,
      "A rotation is already under way: activate or retire its keys first"
    )
    const key = randomBytes(32).toString("hex")
    write((env) => addKey(env, key))
    console.log(
      JSON.stringify({ added: describeKeys(addKey(envs[0], key)).standby[0] })
    )
    console.log(`${reload} Then run: activate --key=<added>`)
  } else if (step === "activate") {
    const id = process.argv.find((v) => v.startsWith("--key="))?.slice(6) ?? ""
    assert.ok(current.standby.includes(id), "Name a standby key with --key=")
    write((env) => activateKey(env, id))
    console.log(JSON.stringify({ active: id }))
    console.log(`${reload} Then run: rekey`)
  } else if (step === "rekey") {
    const result = await rekey(await database(), connectionKeys(envs[0]))
    console.log(JSON.stringify(result))
    console.log("Run rekey again until nothing is skipped, then: retire")
  } else if (step === "retire") {
    const stored = await keyUsage(await database())
    assert.ok(
      stored.every((usage) => usage.key === current.active),
      "Stored values still need another key: run rekey first"
    )
    write(retireKeys)
    console.log(JSON.stringify({ active: current.active, standby: [] }))
    console.log(reload.replace(", before the next step", ""))
  } else
    throw new assert.AssertionError({
      message:
        "Usage: pnpm connections:rotate-key status | add | activate --key=<id> | rekey | retire",
    })
} catch (error) {
  // Assertion messages are this script's own text; anything else may carry arguments.
  if (error instanceof assert.AssertionError) {
    console.error(error.message)
    process.exitCode = 1
  } else fail(error)
} finally {
  await db?.end()
}
