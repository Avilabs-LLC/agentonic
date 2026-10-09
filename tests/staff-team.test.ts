import { afterEach, beforeEach, expect, it } from "vitest"
import { staffTeam } from "../packages/contracts/src/access"
import { createRagFixture, id, owner, staff } from "../scripts/rag-benchmark/fixture"

// Agentonic's team in Admin (migration 68): every active staff member sees the
// team; only administrators see emails and invitations and change anything.
let f: Awaited<ReturnType<typeof createRagFixture>>
const operator = id(4),
  support = id(5),
  newcomer = id(6)
beforeEach(async () => {
  f = await createRagFixture()
  await f.db.exec(`RESET ROLE;
 INSERT INTO auth.users VALUES('${operator}'),('${support}'),('${newcomer}');
 INSERT INTO agentonic.users(id,auth_user_id,display_name,email) VALUES('${operator}','${operator}','Olga','olga@example.test'),('${support}','${support}','Sergio','sergio@example.test');
 UPDATE agentonic.users SET email='staff@example.test' WHERE id='${staff}';
 INSERT INTO agentonic.platform_staff(id,user_id,role) VALUES('${operator}','${operator}','operator'),('${support}','${support}','support');`)
})
afterEach(async () => {
  await f.db.close()
})

type Result = { ok: boolean; id?: string | null; data?: unknown }
async function as(
  user: string,
  { role = "agentonic_admin", email = "" } = {}
) {
  await f.db.exec(`RESET ROLE; SET LOCAL ROLE ${role}`)
  await f.db.query(
    "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id','',true),set_config('agentonic.verified_email',$2,true)",
    [user, email]
  )
}
async function command(operation: string, payload: object = {}) {
  await f.db.exec("SAVEPOINT staff_test")
  try {
    const r = await f.db.query<{ result: Result }>(
      "SELECT agentonic.staff_command($1,$2::jsonb,$3::uuid) result",
      [operation, JSON.stringify(payload), id(998)]
    )
    await f.db.exec("RELEASE SAVEPOINT staff_test")
    return r.rows[0]!.result
  } catch (error) {
    await f.db.exec(
      "ROLLBACK TO SAVEPOINT staff_test; RELEASE SAVEPOINT staff_test"
    )
    throw error
  }
}
const inDays = (days: number) =>
  new Date(Date.now() + days * 86400_000).toISOString()
async function invite(
  email = "nuevo@example.test",
  role = "support",
  token = "a"
) {
  await as(staff)
  return command("invite.issue", {
    email,
    role,
    tokenHash: token.repeat(64),
    expiresAt: inDays(7),
  })
}
async function team(user = staff) {
  await as(user)
  const r = await command("team.list")
  expect(r.ok).toBe(true)
  return staffTeam.parse(r.data)
}
async function events() {
  return (
    await f.sql<{ action: string; details: object; staff_id: string | null }>(
      "SELECT action,details,staff_id FROM agentonic.staff_events ORDER BY created_at,id"
    )
  ).rows
}

it("lists the team to staff, with emails and invitations for administrators only", async () => {
  expect((await invite()).ok).toBe(true)
  const full = await team()
  expect(full.viewer).toEqual({ staffId: staff, role: "administrator" })
  expect(full.staff.map((s) => [s.name, s.role, s.email])).toEqual([
    ["Olga", "operator", "olga@example.test"],
    ["Sergio", "support", "sergio@example.test"],
    ["Staff", "administrator", "staff@example.test"],
  ])
  expect(full.invitations).toEqual([
    expect.objectContaining({ email: "nuevo@example.test", role: "support" }),
  ])
  for (const user of [operator, support]) {
    const limited = await team(user)
    expect(limited.staff.every((s) => s.email === null)).toBe(true)
    expect(limited.invitations).toBeNull()
  }
  // Only the Admin app's role may call it, and only staff get an answer.
  for (const role of ["agentonic_customer", "agentonic_worker", "anon"]) {
    await as(staff, { role })
    await expect(command("team.list")).rejects.toThrow(/permission denied/)
  }
  await as(owner)
  expect((await command("team.list")).ok).toBe(false)
})

it("lets only administrators invite, withdraw and change the team", async () => {
  for (const user of [operator, support]) {
    await as(user)
    expect(
      (
        await command("invite.issue", {
          email: "x@example.test",
          role: "support",
          tokenHash: "b".repeat(64),
          expiresAt: inDays(7),
        })
      ).ok
    ).toBe(false)
    expect(
      (await command("staff.update", { staffId: support, role: "operator" }))
        .ok
    ).toBe(false)
  }
  // Only the three offered roles, at most 7 days, and not someone already on the team.
  expect((await invite("x@example.test", "billing")).ok).toBe(false)
  await as(staff)
  expect(
    (
      await command("invite.issue", {
        email: "x@example.test",
        role: "support",
        tokenHash: "c".repeat(64),
        expiresAt: inDays(8),
      })
    ).ok
  ).toBe(false)
  expect((await invite(" OLGA@example.test ", "support", "d")).ok).toBe(false)
  const issued = await invite("X@Example.test ", "operator", "e")
  expect(issued.ok).toBe(true)
  await as(operator)
  expect(
    (await command("invite.revoke", { invitationId: issued.id })).ok
  ).toBe(false)
  await as(staff)
  expect((await command("invite.revoke", { invitationId: issued.id })).ok).toBe(
    true
  )
  expect((await command("invite.revoke", { invitationId: issued.id })).ok).toBe(
    false
  )
  expect(
    (await command("staff.update", { staffId: support, role: "operator" })).ok
  ).toBe(true)
  // One change at a time: a role or a state, never both, and never a no-op.
  expect(
    (
      await command("staff.update", {
        staffId: support,
        role: "support",
        active: false,
      })
    ).ok
  ).toBe(false)
  expect(
    (await command("staff.update", { staffId: support, role: "operator" })).ok
  ).toBe(false)
  expect(
    (await command("staff.update", { staffId: support, role: "billing" })).ok
  ).toBe(false)
  expect((await command("staff.update", { staffId: support, active: true })).ok).toBe(
    false
  )
  expect((await team()).staff.find((s) => s.id === support)?.role).toBe(
    "operator"
  )
})

it("accepts an invitation only for the invited, verified email while its inviter is an administrator", async () => {
  expect((await invite("Nuevo@example.test", "operator")).ok).toBe(true)
  const token = { tokenHash: "a".repeat(64) }
  await as(newcomer, { email: "otro@example.test" })
  expect((await command("invite.accept", token)).ok).toBe(false)
  await as(newcomer)
  expect((await command("invite.accept", token)).ok).toBe(false)
  await as(newcomer, { role: "agentonic_customer", email: "nuevo@example.test" })
  await expect(command("invite.accept", token)).rejects.toThrow(
    /permission denied/
  )
  await as(newcomer, { email: "nuevo@example.test" })
  const accepted = await command("invite.accept", token)
  expect(accepted.ok).toBe(true)
  const joined = await f.sql<{ role: string; name: string; email: string }>(
    "SELECT s.role,u.display_name AS name,u.email FROM agentonic.platform_staff s JOIN agentonic.users u ON u.id=s.user_id WHERE s.id=$1",
    [accepted.id]
  )
  expect(joined.rows).toEqual([
    { role: "operator", name: "Miembro", email: "nuevo@example.test" },
  ])
  // Used once; and someone already on the team can't accept another.
  await as(newcomer, { email: "nuevo@example.test" })
  expect((await command("invite.accept", token)).ok).toBe(false)
  await invite("nuevo@example.test", "administrator", "f")
  expect((await invite("olga@example.test", "support", "1")).ok).toBe(false)
  await as(newcomer, { email: "nuevo@example.test" })
  expect(
    (await command("invite.accept", { tokenHash: "f".repeat(64) })).ok
  ).toBe(false)

  // An expired invitation, or one whose inviter is no longer an administrator, is refused.
  await f.sql(
    `INSERT INTO agentonic.staff_invitations(email_normalized,role,token_hash,invited_by_staff_id,created_at,expires_at)
     VALUES('olga2@example.test','support',repeat('2',64),$1,clock_timestamp()-interval '9 days',clock_timestamp()-interval '1 day'),
           ('sergio2@example.test','support',repeat('3',64),$2,clock_timestamp(),clock_timestamp()+interval '1 day')`,
    [staff, operator]
  )
  await as(operator, { email: "olga2@example.test" })
  expect(
    (await command("invite.accept", { tokenHash: "2".repeat(64) })).ok
  ).toBe(false)
  await as(support, { email: "sergio2@example.test" })
  expect(
    (await command("invite.accept", { tokenHash: "3".repeat(64) })).ok
  ).toBe(false)
})

it("never lets anyone change themselves; deactivating ends access and withdraws their invitations", async () => {
  await as(staff)
  expect(
    (await command("staff.update", { staffId: staff, active: false })).ok
  ).toBe(false)
  expect(
    (await command("staff.update", { staffId: staff, role: "support" })).ok
  ).toBe(false)
  // Olga becomes an administrator and invites someone.
  expect(
    (
      await command("staff.update", {
        staffId: operator,
        role: "administrator",
      })
    ).ok
  ).toBe(true)
  await as(operator)
  expect(
    (
      await command("invite.issue", {
        email: "pendiente@example.test",
        role: "support",
        tokenHash: "9".repeat(64),
        expiresAt: inDays(3),
      })
    ).ok
  ).toBe(true)
  // Deactivated, she loses access and her pending invitation is withdrawn.
  await as(staff)
  expect(
    (await command("staff.update", { staffId: operator, active: false })).ok
  ).toBe(true)
  await as(operator)
  expect((await command("team.list")).ok).toBe(false)
  await f.db.exec("SAVEPOINT ops")
  await expect(
    f.db.query("SELECT agentonic.operations_agents()")
  ).rejects.toThrow()
  await f.db.exec("ROLLBACK TO SAVEPOINT ops; RELEASE SAVEPOINT ops")
  const after = await team()
  expect(after.invitations?.map((i) => [i.email, Boolean(i.revokedAt)])).toEqual(
    [["pendiente@example.test", true]]
  )
  expect(after.staff.find((s) => s.id === operator)?.status).toBe("disabled")
  // A deactivated person gets no new role until reactivated.
  await as(staff)
  expect(
    (await command("staff.update", { staffId: operator, role: "support" })).ok
  ).toBe(false)
  expect(
    (await command("staff.update", { staffId: operator, active: true })).ok
  ).toBe(true)
  expect((await team(operator)).viewer.role).toBe("administrator")
})

it("records every change, and refused attempts by staff, without emails, tokens or names", async () => {
  expect((await invite()).ok).toBe(true)
  await as(newcomer, { email: "nuevo@example.test" })
  expect((await command("invite.accept", { tokenHash: "a".repeat(64) })).ok).toBe(
    true
  )
  await as(staff)
  expect((await command("staff.update", { staffId: support, role: "operator" })).ok).toBe(
    true
  )
  expect((await command("staff.update", { staffId: support, active: false })).ok).toBe(
    true
  )
  await as(operator)
  expect((await command("staff.update", { staffId: staff, active: false })).ok).toBe(
    false
  )
  const recorded = await events()
  // PGlite's clock can give several events the same time, so compare as a set.
  expect(recorded.map((e) => e.action).sort()).toEqual(
    ["denied", "invite.accept", "invite.issue", "staff.disable", "staff.role"]
  )
  const text = JSON.stringify(recorded)
  for (const secret of ["example.test", "a".repeat(64), "Sergio", "Olga"])
    expect(text).not.toContain(secret)
  // History can't be rewritten.
  await expect(f.sql("DELETE FROM agentonic.staff_events")).rejects.toThrow(
    /Immutable history/
  )
})
