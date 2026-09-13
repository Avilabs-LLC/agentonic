import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "dotenv"
import pg from "pg"
export const root = resolve(import.meta.dirname, "..")
export function loadLocal(file) {
  return parse(readFileSync(resolve(root, file)))
}
export function writeLocal(file, values) {
  writeFileSync(
    resolve(root, file),
    Object.entries(values)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join("\n") + "\n",
    { mode: 0o600 }
  )
  chmodSync(resolve(root, file), 0o600)
}
export function bootstrapConfig() {
  const e = loadLocal(".env.bootstrap.local")
  const project = new URL(e.NEXT_PUBLIC_SUPABASE_URL)
  const db = new URL(e.AGENTONIC_BOOTSTRAP_DATABASE_URL)
  const ref = project.hostname.split(".")[0]
  if (
    project.protocol !== "https:" ||
    !project.hostname.endsWith(".supabase.co") ||
    !decodeURIComponent(db.username).endsWith("." + ref)
  )
    throw new Error("Project/connection mismatch.")
  if (!e.AGENTONIC_DATABASE_CA_FILE)
    throw new Error("Verified database CA file is required.")
  return { e, db, ref }
}
export function pgConfig(raw, ca, extra = {}) {
  const url = new URL(raw)
  return {
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { rejectUnauthorized: true, ca: readFileSync(ca, "utf8") },
    connectionTimeoutMillis: 15000,
    statement_timeout: 15000,
    ...extra,
  }
}
export const connect = async (url, ca) => {
  const c = new pg.Client(pgConfig(url, ca))
  await c.connect()
  return c
}
export function fail(error) {
  // Never echo driver errors: they may contain SQL arguments, URLs or account details.
  console.error(
    "Operation failed. Diagnostic code:",
    /^[A-Z0-9_]+$/.test(error?.code ?? "") ? error.code : "CHECK_CONFIGURATION"
  )
  process.exitCode = 1
}
export { existsSync }
