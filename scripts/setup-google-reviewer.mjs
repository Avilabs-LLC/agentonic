import { createHash, randomBytes } from "node:crypto"
import { mkdirSync, writeFileSync, chmodSync } from "node:fs"
import { resolve } from "node:path"
import { bootstrapConfig, connect, fail, root } from "./local-config.mjs"
// pnpm setup:google-reviewer — the account Google's OAuth reviewers sign in
// with (architecture §85). It creates, once, the "Revisión Google" workspace
// with the platform owner as its owner, and a confirmed customer account with
// a password, as an administrator member of that workspace. The password is
// written to .local/google-reviewer.txt (mode 0600), never printed or
// committed; rerunning sets a new password and rewrites the file.
//
// Nothing else is created: the owner builds the demo agent in that workspace
// through the apps, like any customer would.
const EMAIL = (
  process.env.AGENTONIC_GOOGLE_REVIEWER_EMAIL ?? "google-review@avilabs.tech"
)
  .trim()
  .toLowerCase()
const WORKSPACE = { name: "Revisión Google", slug: "google-review" }
const NAME = "Revisor de Google"
try {
  const { e } = bootstrapConfig()
  const url = e.NEXT_PUBLIC_SUPABASE_URL
  const secret = e.SUPABASE_SECRET_KEY
  if (!secret) throw new Error("SUPABASE_SECRET_KEY is required.")
  if (!e.AGENTONIC_BOOTSTRAP_STAFF_EMAIL)
    throw new Error("AGENTONIC_BOOTSTRAP_STAFF_EMAIL is required.")
  const db = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  const password = randomBytes(18).toString("base64url")
  try {
    await db.query("BEGIN")
    // 1. The workspace, owned by the platform owner's customer identity.
    const owner = (
      await db.query(
        `SELECT u.id FROM agentonic.users u JOIN auth.users a ON a.id=u.auth_user_id
         WHERE lower(a.email)=lower($1) AND u.deleted_at IS NULL AND a.deleted_at IS NULL`,
        [e.AGENTONIC_BOOTSTRAP_STAFF_EMAIL]
      )
    ).rows[0]?.id
    if (!owner)
      throw new Error("The platform owner has no application identity.")
    const retention = {
      conversationsDays: 30,
      checkpointsDays: 7,
      memoryDays: 7,
      sourcesDays: 30,
      logsDays: 7,
      auditDays: 30,
      backupsDays: 7,
    }
    let workspace = (
      await db.query("SELECT id FROM agentonic.workspaces WHERE slug=$1", [
        WORKSPACE.slug,
      ])
    ).rows[0]?.id
    if (!workspace) {
      workspace = (
        await db.query(
          `INSERT INTO agentonic.workspaces(kind,name,slug,timezone,retention_policy)
           VALUES('organization',$1,$2,'UTC',$3) RETURNING id`,
          [WORKSPACE.name, WORKSPACE.slug, retention]
        )
      ).rows[0].id
      await db.query(
        "INSERT INTO agentonic.workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [workspace, owner]
      )
      console.log(`Workspace "${WORKSPACE.name}" created.`)
    } else console.log(`Workspace "${WORKSPACE.name}" exists.`)
    const ownerMember = (
      await db.query(
        "SELECT id FROM agentonic.workspace_members WHERE workspace_id=$1 AND user_id=$2 AND status='active'",
        [workspace, owner]
      )
    ).rows[0]?.id
    if (!ownerMember)
      throw new Error("The owner is not a member of the workspace.")
    // 2. A live invitation, so the sign-up hook lets Auth create the account.
    const existing = (
      await db.query(
        "SELECT id FROM auth.users WHERE lower(email)=$1 AND deleted_at IS NULL",
        [EMAIL]
      )
    ).rows[0]?.id
    if (!existing)
      await db.query(
        `INSERT INTO agentonic.workspace_invitations(workspace_id,email_normalized,role,token_hash,invited_by_member_id,expires_at)
         VALUES($1,$2,'admin',$3,$4,clock_timestamp()+interval '1 hour')`,
        [
          workspace,
          EMAIL,
          createHash("sha256").update(randomBytes(32)).digest("hex"),
          ownerMember,
        ]
      )
    await db.query("COMMIT")
    // 3. The Auth account: confirmed, with a password, no second factor.
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
        body: JSON.stringify({ email: EMAIL, password, email_confirm: true }),
        signal: globalThis.AbortSignal.timeout(15000),
      }
    )
    if (!response.ok)
      throw new Error(
        `Auth refused the reviewer account (HTTP ${response.status}).`
      )
    const authId = (await response.json()).id
    // 4. The application identity and the membership; the invitation is spent.
    await db.query("BEGIN")
    const user = (
      await db.query(
        `INSERT INTO agentonic.users(auth_user_id,display_name,email) VALUES($1,$2,$3)
         ON CONFLICT(auth_user_id) DO UPDATE SET display_name=EXCLUDED.display_name, email=EXCLUDED.email
         RETURNING id, deleted_at`,
        [authId, NAME, EMAIL]
      )
    ).rows[0]
    if (user.deleted_at) throw new Error("The reviewer identity was erased.")
    await db.query(
      `INSERT INTO agentonic.workspace_members(workspace_id,user_id,role) VALUES($1,$2,'admin')
       ON CONFLICT DO NOTHING`,
      [workspace, user.id]
    )
    await db.query(
      `UPDATE agentonic.workspace_invitations SET accepted_at=clock_timestamp()
       WHERE workspace_id=$1 AND email_normalized=$2 AND accepted_at IS NULL AND revoked_at IS NULL`,
      [workspace, EMAIL]
    )
    await db.query("COMMIT")
    mkdirSync(resolve(root, ".local"), { recursive: true })
    const file = resolve(root, ".local/google-reviewer.txt")
    writeFileSync(
      file,
      `Agentonic reviewer account (Google OAuth verification)\nURL: https://app.agentonic.avilabs.tech/login\nEmail: ${EMAIL}\nPassword: ${password}\nWorkspace: ${WORKSPACE.name}\n`,
      { mode: 0o600 }
    )
    chmodSync(file, 0o600)
    console.log(
      `Reviewer account ${existing ? "updated" : "created"}; credentials in .local/google-reviewer.txt.`
    )
  } catch (error) {
    await db.query("ROLLBACK").catch(() => {})
    throw error
  } finally {
    await db.end()
  }
} catch (error) {
  fail(error)
}
