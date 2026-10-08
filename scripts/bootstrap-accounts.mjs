import { bootstrapConfig, connect, fail } from "./local-config.mjs"
// Link already-confirmed Auth users only. No emails, password changes, signups or promotions on login.
try {
  const { e } = bootstrapConfig()
  const accounts = [
    ["staff", e.AGENTONIC_BOOTSTRAP_STAFF_EMAIL],
    ["customer-a", e.AGENTONIC_BOOTSTRAP_CUSTOMER_A_OWNER_EMAIL],
    ["customer-b", e.AGENTONIC_BOOTSTRAP_CUSTOMER_B_OWNER_EMAIL],
  ]
  const client = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  try {
    const found = []
    for (const [label, email] of accounts) {
      if (!email) throw new Error("Missing configured identity.")
      const result = await client.query(
        "SELECT id FROM auth.users WHERE lower(email)=lower($1) AND email_confirmed_at IS NOT NULL AND deleted_at IS NULL",
        [email]
      )
      console.log(
        `${label}: ${result.rowCount === 1 ? "confirmed Auth identity found" : "confirmed Auth identity pending"}`
      )
      if (result.rowCount === 1) found.push({ label, id: result.rows[0].id })
    }
    if (found.length !== accounts.length) {
      console.log(
        "No application identities changed. Create/confirm the three Supabase Auth users, then rerun."
      )
    } else {
      await client.query("BEGIN")
      for (const { label, id } of found) {
        const inserted = await client.query(
          `INSERT INTO agentonic.users(auth_user_id,display_name) VALUES($1,$2)
      ON CONFLICT(auth_user_id) DO UPDATE SET auth_user_id=EXCLUDED.auth_user_id RETURNING id,deleted_at`,
          [
            id,
            label === "staff"
              ? "Leonardo"
              : label === "customer-a"
                ? "Cliente de prueba A"
                : "Cliente de prueba B",
          ]
        )
        if (inserted.rows[0].deleted_at)
          throw new Error("Erased identity cannot be reactivated by bootstrap.")
        const userId = inserted.rows[0].id
        if (label === "staff") {
          await client.query(
            "INSERT INTO agentonic.platform_staff(user_id,role) VALUES($1,'administrator') ON CONFLICT(user_id) DO NOTHING",
            [userId]
          )
        } else {
          // These are nonproduction test workspaces with explicit finite test retention, not customer policy defaults.
          const retention = {
            conversationsDays: 7,
            checkpointsDays: 7,
            memoryDays: 7,
            sourcesDays: 7,
            logsDays: 7,
            auditDays: 30,
            backupsDays: 7,
          }
          const workspace = await client.query(
            `INSERT INTO agentonic.workspaces(kind,name,slug,timezone,retention_policy)
      VALUES('organization',$1,$2,'UTC',$3) ON CONFLICT(slug) DO NOTHING RETURNING id`,
            [
              label === "customer-a"
                ? "Pruebas · Cliente A"
                : "ACME",
              "bootstrap-" + label,
              retention,
            ]
          )
          if (workspace.rowCount)
            await client.query(
              "INSERT INTO agentonic.workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
              [workspace.rows[0].id, userId]
            )
          else {
            const owned = await client.query(
              `SELECT 1 FROM agentonic.workspaces w JOIN agentonic.workspace_members m ON m.workspace_id=w.id WHERE w.slug=$1 AND m.user_id=$2 AND m.role='owner' AND m.status='active'`,
              ["bootstrap-" + label, userId]
            )
            if (!owned.rowCount)
              throw new Error(
                "Existing bootstrap workspace has a different owner."
              )
          }
        }
      }
      await client.query("COMMIT")
      console.log(
        "Confirmed identities linked; staff and two isolated nonproduction workspaces provisioned."
      )
    }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    await client.end()
  }
} catch (error) {
  fail(error)
}
