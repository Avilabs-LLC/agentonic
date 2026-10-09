// Connection key rotation. Stored Gmail secrets name the key that sealed them
// (v2), so a key is replaced in four steps without breaking any holder:
// add the new key everywhere as a standby key, make it active, re-seal stored
// values with it, then retire the old key once nothing needs it.
import {
  connectionKeys,
  keyId,
  seal,
  unseal,
} from "../packages/connectors/src/secrets.ts"

/** Every holder's configuration on the owner's Mac. Staging hosts copy theirs from the first. */
export const KEY_FILES = [
  ".env.staging.local",
  "apps/customer/.env.local",
  "apps/worker/.env.local",
]

const standbyKeys = (env) =>
  (env.AGENTONIC_CONNECTION_STANDBY_KEYS ?? "")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean)

/** The key names a configuration holds, never the keys. */
export function describeKeys(env) {
  const ring = connectionKeys(env)
  return {
    active: ring.active,
    standby: [...ring.keys.keys()].filter((id) => id !== ring.active).sort(),
  }
}

/** A step changes holders only while they all hold the same keys. */
export function sameKeys(envs) {
  const [first, ...rest] = envs.map((env) => JSON.stringify(describeKeys(env)))
  return rest.every((other) => other === first)
}

/** Step 1: every holder can open what the new key seals, before anything is sealed with it. */
export function addKey(env, key) {
  keyId(key)
  return {
    ...env,
    AGENTONIC_CONNECTION_STANDBY_KEYS: [...standbyKeys(env), key].join(","),
  }
}

/** Step 2: the named standby key seals from now on; the old active key stays to open older values. */
export function activateKey(env, id) {
  const standby = standbyKeys(env)
  const next = standby.find((key) => keyId(key) === id)
  if (!next) throw new Error("Unknown standby key")
  return {
    ...env,
    AGENTONIC_CONNECTION_KEY: next,
    AGENTONIC_CONNECTION_STANDBY_KEYS: [
      ...standby.filter((key) => key !== next),
      env.AGENTONIC_CONNECTION_KEY,
    ].join(","),
  }
}

/** Step 4: only the active key remains. */
export function retireKeys(env) {
  const rest = { ...env }
  delete rest.AGENTONIC_CONNECTION_STANDBY_KEYS
  return rest
}

/** Stored Gmail and Drive secrets and the record binding each ciphertext is sealed to. */
const STORED = [
  {
    kind: "connection",
    table: "agentonic.gmail_connections",
    id: "id",
    column: "credential_ciphertext",
    binding: (id) => `gmail:${id}`,
  },
  {
    kind: "invocation",
    table: "agentonic.gmail_invocations",
    id: "id",
    column: "arguments_ciphertext",
    binding: (id) => `invocation:${id}`,
  },
  {
    kind: "oauth",
    table: "agentonic.gmail_oauth_states",
    id: "state_hash",
    column: "verifier_ciphertext",
    binding: (id) => `oauth:${id}`,
  },
  // Google Drive (migration 65), sealed the same way.
  {
    kind: "drive_connection",
    table: "agentonic.drive_connections",
    id: "id",
    column: "credential_ciphertext",
    binding: (id) => `drive:${id}`,
  },
  {
    kind: "drive_invocation",
    table: "agentonic.drive_invocations",
    id: "id",
    column: "arguments_ciphertext",
    binding: (id) => `invocation:${id}`,
  },
  {
    kind: "drive_oauth",
    table: "agentonic.drive_oauth_states",
    id: "state_hash",
    column: "verifier_ciphertext",
    binding: (id) => `oauth:${id}`,
  },
]

/** Stored values per kind and key name ("v1" for values sealed before keys had names). Reads no secret. */
export async function keyUsage(query) {
  const usage = []
  for (const s of STORED) {
    const { rows } = await query(
      `SELECT CASE WHEN ${s.column} LIKE 'v2.%' THEN split_part(${s.column},'.',2) ELSE 'v1' END AS key,count(*)::int AS count
 FROM ${s.table} WHERE coalesce(${s.column},'')<>'' GROUP BY 1 ORDER BY 1`
    )
    for (const row of rows)
      usage.push({ kind: s.kind, key: row.key, count: row.count })
  }
  return usage
}

/**
 * Step 3: re-seals every stored value the active key did not seal. A value
 * changed meanwhile (a disconnect, a finished OAuth) is left alone; running
 * the step again picks up anything still outstanding.
 */
export async function rekey(query, keys) {
  let resealed = 0,
    skipped = 0
  for (const s of STORED) {
    const { rows } = await query(
      `SELECT ${s.id}::text AS id,${s.column} AS value FROM ${s.table}
 WHERE coalesce(${s.column},'')<>'' AND ${s.column} NOT LIKE $1`,
      [`v2.${keys.active}.%`]
    )
    for (const row of rows) {
      const binding = s.binding(row.id)
      const next = seal(unseal(row.value, binding, keys), binding, keys)
      const { rows: updated } = await query(
        `UPDATE ${s.table} SET ${s.column}=$1 WHERE ${s.id}::text=$2 AND ${s.column}=$3 RETURNING 1`,
        [next, row.id, row.value]
      )
      if (updated.length === 1) resealed++
      else skipped++
    }
  }
  return { resealed, skipped }
}
