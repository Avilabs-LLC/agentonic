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
// One-time privileged bootstrap. No passwords reach command arguments or console output.
try {
  const { e, db, ref } = bootstrapConfig()
  const file = ".env.database.local"
  const existing = existsSync(resolve(root, file)) ? loadLocal(file) : {}
  const roles = [
    "agentonic_migrator",
    "agentonic_admin",
    "agentonic_customer",
    "agentonic_worker",
  ]
  const values = {
    ...existing,
    AGENTONIC_DATABASE_CA_FILE: e.AGENTONIC_DATABASE_CA_FILE,
  }
  for (const role of roles) {
    const key =
      role === "agentonic_migrator"
        ? "AGENTONIC_MIGRATION_DATABASE_URL"
        : role.toUpperCase() + "_DATABASE_URL"
    if (!values[key]) {
      const u = new URL(db)
      u.username = role + "." + ref
      u.password = randomBytes(32).toString("hex")
      u.search = "?schema=agentonic"
      values[key] = u.toString()
    }
  }
  // Persist before provisioning so an interrupted retry reuses exactly the same credentials.
  writeLocal(file, values)
  const client = await connect(
    e.AGENTONIC_BOOTSTRAP_DATABASE_URL,
    e.AGENTONIC_DATABASE_CA_FILE
  )
  try {
    await client.query("BEGIN")
    for (const role of roles) {
      const key =
        role === "agentonic_migrator"
          ? "AGENTONIC_MIGRATION_DATABASE_URL"
          : role.toUpperCase() + "_DATABASE_URL"
      const password = decodeURIComponent(new URL(values[key]).password)
      const r = await client.query(
        "SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=$1",
        [role]
      )
      if (r.rowCount) {
        if (r.rows[0].rolsuper || r.rows[0].rolbypassrls)
          throw new Error("Existing role is privileged.")
      } else {
        // Role is from the fixed list; password is encoded with PostgreSQL's own quote_literal.
        const literal = await client.query(
          "SELECT quote_literal($1) AS value",
          [password]
        )
        await client.query(
          `CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${literal.rows[0].value}`
        )
      }
    }
    await client.query("GRANT agentonic_migrator TO postgres")
    await client.query(
      "GRANT CREATE, CONNECT ON DATABASE postgres TO agentonic_migrator"
    )
    // Supabase's auth schema does not delegate grant options to postgres. Expose
    // one fixed DDL operation rather than granting migrator a platform-owned role.
    await client.query(`CREATE SCHEMA IF NOT EXISTS agentonic_bootstrap AUTHORIZATION postgres;
      REVOKE ALL ON SCHEMA agentonic_bootstrap FROM PUBLIC, anon, authenticated, service_role;
      CREATE OR REPLACE FUNCTION agentonic_bootstrap.link_auth_users() RETURNS void
      LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $body$
        ALTER TABLE agentonic.users ADD CONSTRAINT users_auth_user_fk
        FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
      $body$;
      REVOKE ALL ON FUNCTION agentonic_bootstrap.link_auth_users() FROM PUBLIC, anon, authenticated, service_role;
      GRANT USAGE ON SCHEMA agentonic_bootstrap TO agentonic_migrator;
      GRANT EXECUTE ON FUNCTION agentonic_bootstrap.link_auth_users() TO agentonic_migrator;`)
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    await client.end()
  }
  for (const app of ["admin", "customer"]) {
    writeLocal(`apps/${app}/.env.local`, {
      NEXT_PUBLIC_SUPABASE_URL: e.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:
        e.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      DATABASE_URL: values["AGENTONIC_" + app.toUpperCase() + "_DATABASE_URL"],
      AGENTONIC_DATABASE_ROLE: "agentonic_" + app,
      AGENTONIC_DATABASE_CA_FILE: e.AGENTONIC_DATABASE_CA_FILE,
    })
  }
  console.log(
    "Restricted roles provisioned; separate private app environment files written. No Auth users created."
  )
} catch (error) {
  fail(error)
}
