import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { beforeAll, afterAll, describe, it, expect } from "vitest"
import {
  retentionPolicy,
  signInSchema,
} from "../packages/contracts/src/identity"
import { formatMoney } from "../packages/contracts/src/format"
const db = new PGlite()
const a = "11111111-1111-4111-8111-111111111111"
const b = "22222222-2222-4222-8222-222222222222"
const staff = "33333333-3333-4333-8333-333333333333"
const wa = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const wb = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const retention = {
  conversationsDays: 30,
  checkpointsDays: 30,
  memoryDays: 30,
  sourcesDays: 30,
  logsDays: 30,
  auditDays: 90,
  backupsDays: 30,
}
async function asActor(
  role: string,
  actor: string | null,
  workspace: string | null,
  sql: string
) {
  await db.exec(`BEGIN; SET LOCAL ROLE ${role};`)
  try {
    await db.query(
      "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id',$2,true)",
      [actor ?? "", workspace ?? ""]
    )
    return await db.query(sql)
  } finally {
    await db.exec("ROLLBACK")
  }
}
beforeAll(async () => {
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE ROLE agentonic_admin NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE agentonic_customer NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE ROLE agentonic_worker NOLOGIN NOSUPERUSER NOBYPASSRLS;
    CREATE SCHEMA agentonic_bootstrap;
    CREATE FUNCTION agentonic_bootstrap.link_auth_users() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $f$
      ALTER TABLE agentonic.users ADD CONSTRAINT users_auth_user_fk FOREIGN KEY(auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
    $f$;`)
  await db.exec(
    readFileSync(
      "packages/database/prisma/migrations/202609130001_identity/migration.sql",
      "utf8"
    )
  )
  await db.exec("BEGIN")
  for (const [id, name] of [
    [a, "A"],
    [b, "B"],
    [staff, "Staff"],
  ]) {
    await db.query("INSERT INTO auth.users VALUES ($1)", [id])
    await db.query(
      "INSERT INTO agentonic.users (id,auth_user_id,display_name) VALUES ($1,$1,$2)",
      [id, name]
    )
  }
  await db.query(
    "INSERT INTO agentonic.platform_staff(user_id,role) VALUES ($1,'administrator')",
    [staff]
  )
  for (const [w, user, name] of [
    [wa, a, "A"],
    [wb, b, "B"],
  ]) {
    await db.query(
      "INSERT INTO agentonic.workspaces(id,kind,name,slug,timezone,retention_policy) VALUES ($1,'organization',$2,$2,'UTC',$3)",
      [w, name, JSON.stringify(retention)]
    )
    await db.query(
      "INSERT INTO agentonic.workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'owner')",
      [w, user]
    )
  }
  await db.exec("COMMIT")
}, 30_000)
afterAll(() => db.close())

describe("restricted identity and tenant policies", () => {
  for (const role of ["agentonic_admin", "agentonic_customer"]) {
    it(`${role}: no identity denies global/tenant reads`, async () => {
      for (const table of [
        "users",
        "platform_staff",
        "workspaces",
        "workspace_members",
      ])
        expect(
          (await asActor(role, null, null, `SELECT * FROM agentonic.${table}`))
            .rows
        ).toEqual([])
    })
    it(`${role}: identity alone does not expose tenant rows`, async () => {
      expect(
        (await asActor(role, a, null, "SELECT * FROM agentonic.workspaces"))
          .rows
      ).toEqual([])
      expect(
        (await asActor(role, a, null, "SELECT * FROM agentonic.users")).rows
      ).toHaveLength(1)
    })
    it(`${role}: only own workspace is readable`, async () => {
      expect(
        (await asActor(role, a, wa, "SELECT * FROM agentonic.workspaces")).rows
      ).toHaveLength(1)
      expect(
        (await asActor(role, a, wb, "SELECT * FROM agentonic.workspaces")).rows
      ).toEqual([])
      expect(
        (
          await asActor(
            role,
            b,
            wa,
            "SELECT * FROM agentonic.workspace_members"
          )
        ).rows
      ).toEqual([])
    })
    it(`${role}: discovery returns only current memberships`, async () => {
      expect(
        (
          await asActor(
            role,
            a,
            null,
            "SELECT agentonic.authorized_workspace_ids() AS id"
          )
        ).rows
      ).toEqual([{ id: wa }])
    })
    it(`${role}: customer cannot become staff`, async () => {
      expect(
        (await asActor(role, a, wa, "SELECT * FROM agentonic.platform_staff"))
          .rows
      ).toEqual([])
      await expect(
        asActor(
          role,
          a,
          wa,
          `INSERT INTO agentonic.platform_staff(user_id,role) VALUES ('${a}','administrator')`
        )
      ).rejects.toThrow(/permission denied/)
    })
    it(`${role}: staff is not a customer member`, async () => {
      expect(
        (
          await asActor(
            role,
            staff,
            wa,
            "SELECT * FROM agentonic.platform_staff"
          )
        ).rows
      ).toHaveLength(1)
      expect(
        (await asActor(role, staff, wa, "SELECT * FROM agentonic.workspaces"))
          .rows
      ).toEqual([])
    })
    it(`${role}: customer writes are denied`, async () => {
      await expect(
        asActor(role, a, wa, "UPDATE agentonic.workspaces SET name='changed'")
      ).rejects.toThrow(/permission denied/)
      await expect(
        asActor(role, a, wa, "DELETE FROM agentonic.workspace_members")
      ).rejects.toThrow(/permission denied/)
    })
  }
  it("rollbacks and commits do not leak transaction context", async () => {
    await asActor(
      "agentonic_customer",
      a,
      wa,
      "SELECT * FROM agentonic.workspaces"
    )
    expect(
      (
        await db.query(
          "SELECT nullif(current_setting('agentonic.auth_user_id',true),'') AS actor"
        )
      ).rows
    ).toEqual([{ actor: null }])
    await db.exec("BEGIN; SET LOCAL ROLE agentonic_customer")
    await db.query("SELECT set_config('agentonic.auth_user_id',$1,true)", [a])
    await db.exec("COMMIT")
    expect(
      (
        await asActor(
          "agentonic_customer",
          b,
          null,
          "SELECT * FROM agentonic.users"
        )
      ).rows
    ).toHaveLength(1)
    expect(
      (
        await asActor(
          "agentonic_customer",
          null,
          null,
          "SELECT * FROM agentonic.users"
        )
      ).rows
    ).toEqual([])
  })
  for (const role of [
    "anon",
    "authenticated",
    "service_role",
    "agentonic_worker",
  ]) {
    it(`${role} has no application-schema access`, async () => {
      await expect(
        asActor(role, a, wa, "SELECT * FROM agentonic.users")
      ).rejects.toThrow(/permission denied/)
    })
  }
  it("membership revocation takes effect immediately", async () => {
    await db.exec("BEGIN")
    try {
      await db.query(
        "UPDATE agentonic.workspace_members SET status='suspended' WHERE user_id=$1",
        [a]
      )
      await db.exec("SET LOCAL ROLE agentonic_customer")
      await db.query(
        "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id',$2,true)",
        [a, wa]
      )
      expect(
        (await db.query("SELECT * FROM agentonic.workspaces")).rows
      ).toEqual([])
    } finally {
      await db.exec("ROLLBACK")
    }
  })
  it("cannot remove the last active owner", async () => {
    await db.exec("BEGIN")
    try {
      await db.query(
        "DELETE FROM agentonic.workspace_members WHERE workspace_id=$1",
        [wa]
      )
      await expect(db.exec("SET CONSTRAINTS ALL IMMEDIATE")).rejects.toThrow(
        /requires an active owner/
      )
    } finally {
      await db.exec("ROLLBACK")
    }
  })
  it("rejects invalid timezones and unbounded retention", async () => {
    await expect(
      db.query(
        "UPDATE agentonic.workspaces SET timezone='Mars/Base' WHERE id=$1",
        [wa]
      )
    ).rejects.toThrow(/timezone/)
    await expect(
      db.query(
        "UPDATE agentonic.workspaces SET retention_policy='{}' WHERE id=$1",
        [wa]
      )
    ).rejects.toThrow(/retention/)
  })
  it("rejects moved tenant relationships and missing Auth identities", async () => {
    await expect(
      db.query(
        "UPDATE agentonic.workspace_members SET workspace_id=$1 WHERE user_id=$2",
        [wb, a]
      )
    ).rejects.toThrow(/immutable/)
    await expect(
      db.query(
        "INSERT INTO agentonic.users(display_name,auth_user_id) VALUES ('Unknown',gen_random_uuid())"
      )
    ).rejects.toThrow(/foreign key/)
  })
})
it("shared validation and unknown costs preserve meaning", () => {
  expect(
    signInSchema.safeParse({ email: "invalid", password: "" }).success
  ).toBe(false)
  expect(retentionPolicy.safeParse({ ...retention, logsDays: 0 }).success).toBe(
    false
  )
  expect(retentionPolicy.safeParse(retention).success).toBe(true)
  expect(formatMoney(null)).toBe("Sin medir")
  expect(formatMoney(0)).not.toBe("Sin medir")
})
