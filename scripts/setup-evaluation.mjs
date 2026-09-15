import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import {
  bootstrapConfig,
  connect,
  existsSync,
  root,
  writeLocal,
  loadLocal,
  fail,
} from "./local-config.mjs"
// Creates only dedicated evaluator credentials. Never rotates existing credentials,
// changes web/ingestion environments, or resets provider usage/allowances.
let client
try {
  const { e, db, ref } = bootstrapConfig()
  assert.equal(
    ref,
    "jkgdxkacariasunhentd",
    "Explicit nonproduction project required"
  )
  const file = ".env.evaluation.local"
  const values = existsSync(resolve(root, file)) ? loadLocal(file) : {}
  values.AGENTONIC_DATABASE_CA_FILE = e.AGENTONIC_DATABASE_CA_FILE
  const roles = ["agentonic_eval_local", "agentonic_eval_azure"]
  for (const role of roles) {
    const key = role.toUpperCase() + "_DATABASE_URL"
    if (!values[key]) {
      const url = new URL(db)
      url.username = role + "." + ref
      url.password = randomBytes(32).toString("hex")
      url.search = "?schema=agentonic"
      values[key] = url.toString()
    }
  }
  writeLocal(file, values)
  client = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  await client.query("BEGIN")
  for (const role of roles) {
    const existing = await client.query(
      "SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolinherit FROM pg_roles WHERE rolname=$1",
      [role]
    )
    if (existing.rowCount)
      assert.ok(
        Object.values(existing.rows[0]).every((value) => value === false)
      )
    else {
      const literal = await client.query("SELECT quote_literal($1) value", [
        decodeURIComponent(
          new URL(values[role.toUpperCase() + "_DATABASE_URL"]).password
        ),
      ])
      await client.query(
        `CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal.rows[0].value}`
      )
    }
  }
  await client.query("COMMIT")
  console.log(
    "Dedicated nonproduction evaluator roles prepared; usage and existing workers preserved."
  )
} catch (error) {
  await client?.query("ROLLBACK")
  fail(error)
} finally {
  await client?.end()
}
