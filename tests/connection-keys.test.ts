import { afterEach, beforeEach, expect, it } from "vitest"
import { createCipheriv, randomBytes } from "node:crypto"
import {
  keyId,
  keyring,
  seal,
  sealedWith,
  unseal,
} from "../packages/connectors/src/secrets"
// @ts-expect-error -- plain ESM script without type declarations
import * as rotation from "../scripts/connection-keys.mjs"
import { createRagFixture, id, w } from "../scripts/rag-benchmark/fixture"

const oldKey = "a".repeat(64),
  newKey = "b".repeat(64)

/** The format before keys had names, as stored by earlier releases. */
function sealV1(value: unknown, binding: string, key: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", Buffer.from(key, "hex"), iv)
  cipher.setAAD(Buffer.from(binding))
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ])
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    bytes.toString("base64url"),
  ].join(".")
}

it("names the sealing key and opens a value only with that key", () => {
  const value = seal({ refreshToken: "synthetic" }, "gmail:x", oldKey)
  expect(value.startsWith(`v2.${keyId(oldKey)}.`)).toBe(true)
  expect(sealedWith(value)).toBe(keyId(oldKey))
  expect(value).not.toContain(oldKey)
  // A holder with the key on standby still opens it; one without it cannot.
  expect(unseal(value, "gmail:x", keyring(newKey, [oldKey]))).toEqual({
    refreshToken: "synthetic",
  })
  expect(() => unseal(value, "gmail:x", keyring(newKey))).toThrow(
    "gmail_secret_unavailable"
  )
  // Renaming the key in the value does not make another key open it.
  const renamed = value.replace(keyId(oldKey), keyId(newKey))
  expect(() => unseal(renamed, "gmail:x", keyring(newKey, [oldKey]))).toThrow(
    "gmail_secret_unavailable"
  )
})

it("still opens values sealed before keys had names, with any configured key", () => {
  const legacy = sealV1("verifier", "oauth:y", oldKey)
  expect(sealedWith(legacy)).toBe("v1")
  expect(unseal(legacy, "oauth:y", keyring(newKey, oldKey))).toBe("verifier")
  expect(() => unseal(legacy, "oauth:y", keyring(newKey))).toThrow()
  expect(() => unseal(legacy, "oauth:z", keyring(oldKey))).toThrow()
})

it("rejects malformed keys and never exposes a key through its name", () => {
  expect(() => keyring("not-a-key")).toThrow("gmail_configuration_required")
  expect(() => keyring(oldKey, ["short"])).toThrow()
  expect(keyId(oldKey)).toMatch(/^[a-f0-9]{16}$/)
  expect(keyId(oldKey)).not.toBe(keyId(newKey))
  expect(keyring(oldKey, ` ${newKey} ,`).keys.size).toBe(2)
})

it("rotates configuration in steps every holder can follow", () => {
  const env = { AGENTONIC_CONNECTION_KEY: oldKey, OTHER: "kept" }
  const added = rotation.addKey(env, newKey)
  // Step 1 seals nothing new: the old key stays active.
  expect(rotation.describeKeys(added)).toEqual({
    active: keyId(oldKey),
    standby: [keyId(newKey)],
  })
  expect(rotation.sameKeys([added, env])).toBe(false)
  expect(rotation.sameKeys([added, rotation.addKey(env, newKey)])).toBe(true)
  const active = rotation.activateKey(added, keyId(newKey))
  expect(rotation.describeKeys(active)).toEqual({
    active: keyId(newKey),
    standby: [keyId(oldKey)],
  })
  expect(() => rotation.activateKey(added, keyId("c".repeat(64)))).toThrow()
  const retired = rotation.retireKeys(active)
  expect(retired).toEqual({ AGENTONIC_CONNECTION_KEY: newKey, OTHER: "kept" })
  expect(JSON.stringify(rotation.describeKeys(active))).not.toContain(newKey)
})

let f: Awaited<ReturnType<typeof createRagFixture>>
beforeEach(async () => {
  f = await createRagFixture()
})
afterEach(async () => {
  await f.db.close()
})

async function gmail(operation: string, payload: Record<string, unknown>) {
  await f.actor()
  const r = await f.db.query<{ r: Record<string, unknown> }>(
    "SELECT agentonic.gmail_command($1,$2::jsonb) r",
    [operation, JSON.stringify(payload)]
  )
  return r.rows[0]!.r
}
const query = (text: string, values?: unknown[]) => f.sql(text, values)

/** Proposes a Gmail draft from a private preview turn, as the preview worker does. */
async function proposeDraft(
  connection: string,
  invocation: string,
  ciphertext: string
) {
  await f.sql(
    `INSERT INTO agentonic.code_releases(id,version,template_version_id,git_commit_sha,artifact_sha256,registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,artifact_key,artifact_size_bytes,published_by_staff_id,execution_manifest)
    SELECT $1,'gmail-preview',template_version_id,repeat('d',40),repeat('e',64),registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,'gmail-preview',artifact_size_bytes,published_by_staff_id,'{"previewContract":"1","gmailContract":"1","model":"gpt-4.1-mini-2025-04-14"}' FROM agentonic.code_releases WHERE id=$2`,
    [id(41), id(40)]
  )
  await f.sql(
    "INSERT INTO agentonic.workspace_code_release_grants(workspace_id,code_release_id,granted_by_staff_id) VALUES($1,$2,$3)",
    [w, id(41), id(3)]
  )
  const operations = ["gmail.drafts.create"]
  await gmail("permissions", {
    agentId: id(20),
    connectionId: connection,
    operations,
  })
  await f.actor()
  await f.command("draft.save", {
    agentId: id(20),
    revision: 0,
    content: {
      version: 1,
      systemPrompt: "Synthetic mailbox assistant for key rotation tests.",
      skills: [],
    },
    requestedAccess: {
      version: 1,
      collectionIds: [],
      tools: [{ connectionId: connection, operations }],
    },
  })
  const candidate = await f.command("candidate.freeze", {
    agentId: id(20),
    revision: 1,
    codeReleaseId: id(41),
  })
  const preview = async (
    operation: string,
    payload: Record<string, unknown>
  ) => {
    await f.actor()
    return (
      await f.db.query<{ r: Record<string, unknown> }>(
        "SELECT agentonic.preview_command($1,$2::jsonb) r",
        [operation, JSON.stringify({ agentId: id(20), ...payload })]
      )
    ).rows[0]!.r
  }
  const started = await preview("start", {
    candidateId: candidate.id,
    enableTools: true,
  })
  await preview("turn", {
    previewId: started.id,
    query: "Draft a synthetic note",
    requestKey: id(703),
  })
  const job = (await f.claim()) as { id: string; token: string }
  await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
  await f.db.query(
    "SELECT agentonic.gmail_preview_worker('gmail-propose',$1,$2,$3::jsonb)",
    [
      job.id,
      job.token,
      JSON.stringify({
        connectionId: connection,
        operation: "gmail.drafts.create",
        id: invocation,
        argumentsCiphertext: ciphertext,
        hash: "e".repeat(64),
      }),
    ]
  )
}

it("re-seals every stored Gmail and Drive secret with the active key and leaves nothing for the old one", async () => {
  // A connection and an OAuth start sealed before keys had names, and a
  // proposal sealed with the old key's name.
  const connection = id(501),
    state = "c".repeat(64),
    pending = "d".repeat(64),
    invocation = id(601)
  await gmail("oauth.start", {
    agentId: id(20),
    connectionId: connection,
    state,
    verifier: sealV1("verifier-1", `oauth:${state}`, oldKey),
  })
  await gmail("oauth.consume", { state })
  await gmail("oauth.finish", {
    state,
    account: "synthetic@example.invalid",
    credential: sealV1(
      { refreshToken: "synthetic" },
      `gmail:${connection}`,
      oldKey
    ),
  })
  await gmail("oauth.start", {
    agentId: id(20),
    connectionId: id(502),
    state: pending,
    verifier: sealV1("verifier-2", `oauth:${pending}`, oldKey),
  })
  // A draft proposal from a private preview turn, sealed with the old key's name.
  await proposeDraft(
    connection,
    invocation,
    seal({ to: ["x@example.invalid"] }, `invocation:${invocation}`, oldKey)
  )
  // A Google Drive connection sealed with the old key's name (migration 65).
  const drive = id(504),
    driveState = "f".repeat(64)
  const driveCommand = async (
    operation: string,
    payload: Record<string, unknown>
  ) => {
    await f.actor()
    return (
      await f.db.query<{ r: Record<string, unknown> }>(
        "SELECT agentonic.drive_command($1,$2::jsonb) r",
        [operation, JSON.stringify(payload)]
      )
    ).rows[0]!.r
  }
  await driveCommand("oauth.start", {
    purpose: "tools",
    agentId: id(20),
    connectionId: drive,
    state: driveState,
    verifier: seal("verifier-3", `oauth:${driveState}`, oldKey),
  })
  await driveCommand("oauth.consume", { state: driveState })
  await driveCommand("oauth.finish", {
    state: driveState,
    account: "synthetic@example.invalid",
    connectionId: drive,
    credential: seal({ refreshToken: "drive" }, `drive:${drive}`, oldKey),
  })
  expect(await rotation.keyUsage(query)).toEqual([
    { kind: "connection", key: "v1", count: 1 },
    { kind: "invocation", key: keyId(oldKey), count: 1 },
    { kind: "oauth", key: "v1", count: 1 },
    { kind: "drive_connection", key: keyId(oldKey), count: 1 },
  ])

  // A key the ring lacks stops the step before anything changes.
  await expect(rotation.rekey(query, keyring(newKey))).rejects.toThrow(
    "gmail_secret_unavailable"
  )
  expect(
    (await rotation.keyUsage(query)).map((u: { key: string }) => u.key)
  ).not.toContain(keyId(newKey))

  const keys = keyring(newKey, [oldKey])
  expect(await rotation.rekey(query, keys)).toEqual({ resealed: 4, skipped: 0 })
  expect(await rotation.keyUsage(query)).toEqual([
    { kind: "connection", key: keyId(newKey), count: 1 },
    { kind: "invocation", key: keyId(newKey), count: 1 },
    { kind: "oauth", key: keyId(newKey), count: 1 },
    { kind: "drive_connection", key: keyId(newKey), count: 1 },
  ])
  // Contents and bindings survive; the old key is no longer needed.
  const only = keyring(newKey)
  const stored = (
    await f.sql<{ c: string; a: string; v: string }>(
      `SELECT (SELECT credential_ciphertext FROM agentonic.gmail_connections WHERE id=$1) c,
 (SELECT arguments_ciphertext FROM agentonic.gmail_invocations WHERE id=$2) a,
 (SELECT verifier_ciphertext FROM agentonic.gmail_oauth_states WHERE state_hash=$3) v`,
      [connection, invocation, pending]
    )
  ).rows[0]!
  expect(unseal(stored.c, `gmail:${connection}`, only)).toEqual({
    refreshToken: "synthetic",
  })
  expect(unseal(stored.a, `invocation:${invocation}`, only)).toEqual({
    to: ["x@example.invalid"],
  })
  expect(unseal(stored.v, `oauth:${pending}`, only)).toBe("verifier-2")
  const sealedDrive = (
    await f.sql<{ c: string }>(
      "SELECT credential_ciphertext c FROM agentonic.drive_connections WHERE id=$1",
      [drive]
    )
  ).rows[0]!.c
  expect(unseal(sealedDrive, `drive:${drive}`, only)).toEqual({
    refreshToken: "drive",
  })
  // Nothing is left to do, and a finished OAuth's emptied verifier is never touched.
  expect(await rotation.rekey(query, keys)).toEqual({ resealed: 0, skipped: 0 })
})
