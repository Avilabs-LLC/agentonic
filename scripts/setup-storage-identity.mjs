import assert from "node:assert/strict"
import { appendFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import { resolve } from "node:path"
import {
  bootstrapConfig,
  connect,
  loadLocal,
  root,
  writeLocal,
  fail,
} from "./local-config.mjs"
// Gives the knowledge worker its own Storage account and takes the Supabase
// secret key out of its configuration (architecture §44). The account's
// app_metadata names it (agentonic_service=storage_worker), which only the Auth
// admin can set; Storage rules (migration 42) let it read a document only while
// an ingestion or purge job for it holds a live lease, and delete one only
// during its purge. Running this again sets a new password. Prints no secret.
const EMAIL = "storage-worker@agentonic.invalid"
const SERVICE = "storage_worker"
try {
  const { e: bootstrap } = bootstrapConfig()
  const worker = loadLocal("apps/worker/.env.local")
  const secret = bootstrap.SUPABASE_SECRET_KEY || worker.SUPABASE_SECRET_KEY
  assert.ok(
    secret,
    "The Supabase secret key is needed once, in .env.bootstrap.local"
  )
  const url = new URL(bootstrap.NEXT_PUBLIC_SUPABASE_URL).origin
  const publishable = bootstrap.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  assert.ok(publishable, "The publishable key is needed")
  assert.equal(
    new URL(worker.SUPABASE_URL).origin,
    url,
    "The worker and bootstrap configurations name different projects"
  )
  // The key stays with the owner's bootstrap configuration, before the worker's copy goes.
  if (!bootstrap.SUPABASE_SECRET_KEY)
    appendFileSync(
      resolve(root, ".env.bootstrap.local"),
      `\n# Bootstrap only (setup-storage-identity.mjs, live checks); never in an application.\nSUPABASE_SECRET_KEY=${JSON.stringify(secret)}\n`,
      { mode: 0o600 }
    )
  const db = await connect(
    bootstrap.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    bootstrap.AGENTONIC_DATABASE_CA_FILE
  )
  let existing
  try {
    existing = (
      await db.query(
        "SELECT id FROM auth.users WHERE lower(email)=lower($1) AND deleted_at IS NULL",
        [EMAIL]
      )
    ).rows[0]?.id
    // A platform account is never an application user.
    if (existing)
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int n FROM agentonic.users WHERE auth_user_id=$1",
            [existing]
          )
        ).rows[0].n,
        0,
        "The storage account is linked to an application user"
      )
  } finally {
    await db.end()
  }
  const password = randomBytes(32).toString("hex")
  const response = await globalThis.fetch(
    `${url}/auth/v1/admin/users${existing ? `/${existing}` : ""}`,
    {
      method: existing ? "PUT" : "POST",
      headers: {
        apikey: secret,
        ...(secret.startsWith("sb_secret_")
          ? {}
          : { Authorization: `Bearer ${secret}` }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: EMAIL,
        password,
        email_confirm: true,
        app_metadata: { agentonic_service: SERVICE },
      }),
      signal: globalThis.AbortSignal.timeout(15000),
    }
  )
  assert.ok(
    response.ok,
    `Auth refused the storage account (HTTP ${response.status})`
  )
  // Prove the account signs in with the publishable key and carries its service name.
  const signedIn = await globalThis.fetch(
    `${url}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: publishable, "Content-Type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password }),
      signal: globalThis.AbortSignal.timeout(15000),
    }
  )
  assert.ok(
    signedIn.ok,
    `The storage account cannot sign in (HTTP ${signedIn.status})`
  )
  const { access_token: token } = await signedIn.json()
  const claims = JSON.parse(
    Buffer.from(String(token).split(".")[1] ?? "", "base64url").toString()
  )
  assert.equal(claims.app_metadata?.agentonic_service, SERVICE)
  delete worker.SUPABASE_SECRET_KEY
  writeLocal("apps/worker/.env.local", {
    ...worker,
    SUPABASE_PUBLISHABLE_KEY: publishable,
    AGENTONIC_STORAGE_EMAIL: EMAIL,
    AGENTONIC_STORAGE_PASSWORD: password,
  })
  console.log(
    JSON.stringify({
      storageAccount: existing ? "password reset" : "created",
      workerHoldsSecretKey: false,
    })
  )
  console.log("Restart the knowledge worker to load its storage account.")
} catch (error) {
  // Assertion messages are this script's own text; anything else may carry arguments.
  if (error instanceof assert.AssertionError) {
    console.error(error.message)
    process.exitCode = 1
  } else fail(error)
}
