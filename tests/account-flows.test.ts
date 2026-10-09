import { afterEach, beforeEach, expect, it } from "vitest"
import {
  createRagFixture,
  id,
  member,
  staff,
  w,
} from "../scripts/rag-benchmark/fixture"

// Invite-only accounts (migration 49): Supabase Auth asks this hook before it
// creates any account; only an email with a live invitation gets one.
let f: Awaited<ReturnType<typeof createRagFixture>>
beforeEach(async () => {
  f = await createRagFixture()
})
afterEach(async () => {
  await f.db.close()
})

async function hook(email: string | null) {
  const r = await f.sql<{ result: Record<string, unknown> }>(
    "SELECT agentonic.auth_before_user_created($1::jsonb) result",
    [
      JSON.stringify({
        metadata: { name: "before-user-created" },
        user: { email },
      }),
    ]
  )
  return r.rows[0]!.result
}
async function invite(
  email: string,
  {
    expiresIn = "1 day",
    accepted = false,
    revoked = false,
    n = 1,
  }: {
    expiresIn?: string
    accepted?: boolean
    revoked?: boolean
    n?: number
  } = {}
) {
  await f.sql(
    `INSERT INTO agentonic.workspace_invitations(id,workspace_id,email_normalized,role,token_hash,invited_by_member_id,created_at,expires_at,accepted_at,revoked_at)
     VALUES($1,$2,$3,'member',$4,$5,clock_timestamp()-interval '2 days',clock_timestamp()+$6::interval,$7,$8)`,
    [
      id(900 + n),
      w,
      email,
      String(n).repeat(64).slice(0, 64),
      member,
      expiresIn,
      accepted ? new Date().toISOString() : null,
      revoked ? new Date().toISOString() : null,
    ]
  )
}
const refused = {
  error: {
    http_code: 403,
    message:
      "Agentonic solo crea cuentas por invitación. Pide a tu equipo que te invite.",
  },
}

it("creates an account only for an email with a live invitation, whatever its case or spacing", async () => {
  expect(await hook("nuevo@example.test")).toEqual(refused)
  await invite("nuevo@example.test")
  expect(await hook("nuevo@example.test")).toEqual({})
  expect(await hook("  Nuevo@Example.TEST ")).toEqual({})
  expect(await hook("otro@example.test")).toEqual(refused)
  expect(await hook(null)).toEqual(refused)
  expect(await hook("")).toEqual(refused)
})

it("refuses expired, accepted and revoked invitations, and invitations to an inactive workspace", async () => {
  await invite("vencida@example.test", { expiresIn: "-1 minute", n: 2 })
  await invite("aceptada@example.test", { accepted: true, n: 3 })
  await invite("retirada@example.test", { revoked: true, n: 4 })
  await invite("suspendida@example.test", { n: 5 })
  await f.sql(
    "UPDATE agentonic.workspaces SET status='suspended' WHERE id=$1",
    [w]
  )
  for (const email of [
    "vencida@example.test",
    "aceptada@example.test",
    "retirada@example.test",
    "suspendida@example.test",
  ])
    expect(await hook(email)).toEqual(refused)
})

it("also creates an account for a live invitation to Agentonic's team (migration 68)", async () => {
  const staffInvite = (email: string, n: number, extra = "") =>
    f.sql(
      `INSERT INTO agentonic.staff_invitations(email_normalized,role,token_hash,invited_by_staff_id,created_at,expires_at${extra ? ",accepted_at,revoked_at" : ""})
       VALUES($1,'support',$2,$3,clock_timestamp()-interval '2 days',clock_timestamp()+interval '1 day'${extra})`,
      [email, String(n).repeat(64).slice(0, 64), staff]
    )
  expect(await hook("equipo@example.test")).toEqual(refused)
  await staffInvite("equipo@example.test", 6)
  expect(await hook(" Equipo@Example.test")).toEqual({})
  await staffInvite("aceptada@example.test", 7, ",clock_timestamp(),NULL")
  await staffInvite("retirada@example.test", 8, ",NULL,clock_timestamp()")
  await f.sql(
    `INSERT INTO agentonic.staff_invitations(email_normalized,role,token_hash,invited_by_staff_id,created_at,expires_at)
     VALUES('vencida@example.test','support',repeat('9',64),$1,clock_timestamp()-interval '9 days',clock_timestamp()-interval '1 minute')`,
    [staff]
  )
  for (const email of [
    "aceptada@example.test",
    "retirada@example.test",
    "vencida@example.test",
  ])
    expect(await hook(email)).toEqual(refused)
})

it("is callable only by Supabase Auth, never by the apps or the public", async () => {
  for (const role of ["agentonic_customer", "agentonic_admin", "anon"]) {
    await f.db.exec(`SAVEPOINT hook_role; RESET ROLE; SET LOCAL ROLE ${role}`)
    await expect(
      f.db.query("SELECT agentonic.auth_before_user_created('{}'::jsonb)")
    ).rejects.toThrow(/permission denied/)
    await f.db.exec("ROLLBACK TO SAVEPOINT hook_role")
  }
  await f.db.exec("RESET ROLE")
})

it("installs a public wrapper only Supabase Auth may run, which applies the same rule", async () => {
  const { readFileSync } = await import("node:fs")
  // Migration 49 grants these where Supabase's role exists; mirror that here.
  await f.db.exec(`RESET ROLE; CREATE ROLE supabase_auth_admin;
    GRANT USAGE ON SCHEMA agentonic TO supabase_auth_admin;
    GRANT EXECUTE ON FUNCTION agentonic.auth_before_user_created(jsonb) TO supabase_auth_admin;`)
  await f.db.exec(readFileSync("scripts/sql/auth-hook.sql", "utf8"))
  await invite("invitada@example.test")
  const call = async (role: string, email: string) => {
    await f.db.exec(`SAVEPOINT wrapper; RESET ROLE; SET LOCAL ROLE ${role}`)
    try {
      const r = await f.db.query<{ result: unknown }>(
        "SELECT public.agentonic_before_user_created($1::jsonb) result",
        [JSON.stringify({ user: { email } })]
      )
      return r.rows[0]!.result
    } finally {
      await f.db.exec("ROLLBACK TO SAVEPOINT wrapper")
    }
  }
  expect(await call("supabase_auth_admin", "invitada@example.test")).toEqual({})
  expect(await call("supabase_auth_admin", "otra@example.test")).toEqual(
    refused
  )
  for (const role of ["anon", "authenticated", "agentonic_customer"])
    await expect(call(role, "invitada@example.test")).rejects.toThrow(
      /permission denied/
    )
  await f.db.exec("RESET ROLE")
})
