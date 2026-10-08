import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
} from "vitest"
import { accessCommand, supportScope } from "../packages/contracts/src/access"
const db = new PGlite()
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, "0")}`
const owner = id(1),
  other = id(2),
  colleague = id(3),
  viewer = id(4),
  admin = id(5),
  staff = id(6),
  billing = id(7),
  newcomer = id(8)
const wa = id(101),
  wb = id(102),
  agent = id(201),
  privateAgent = id(202),
  collection = id(301),
  template = id(401),
  privateTemplate = id(402),
  contact = id(501)
const member = (user: string) => id(Number(user.slice(-12)) + 1000)
const staffId = id(601)
const future = () => new Date(Date.now() + 86400_000).toISOString()
async function actor(
  user: string | null = owner,
  workspace: string | null = wa,
  role = "agentonic_customer",
  email = ""
) {
  await db.exec(`RESET ROLE; SET LOCAL ROLE ${role}`)
  await db.query(
    "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id',$2,true),set_config('agentonic.verified_email',$3,true)",
    [user ?? "", workspace ?? "", email]
  )
}
async function command(
  operation: string,
  payload: Record<string, unknown> = {}
) {
  await db.exec("SAVEPOINT access_test_command")
  try {
    const r = await db.query<{
      result: { ok: boolean; id: string; data: unknown }
    }>("SELECT agentonic.access_command($1,$2::jsonb,$3::uuid) AS result", [
      operation,
      JSON.stringify(payload),
      id(999),
    ])
    await db.exec("RELEASE SAVEPOINT access_test_command")
    return r.rows[0]!.result
  } catch (error) {
    await db.exec(
      "ROLLBACK TO SAVEPOINT access_test_command; RELEASE SAVEPOINT access_test_command"
    )
    throw error
  }
}
async function ownerSql(sql: string, params: unknown[] = []) {
  await db.exec("RESET ROLE")
  return db.query(sql, params)
}
async function can(
  kind: "agent" | "collection",
  target: string,
  operation: string
) {
  return (
    await db.query<{ allowed: boolean }>(
      `SELECT agentonic.can_${kind}($1,$2) AS allowed`,
      [target, operation]
    )
  ).rows[0]!.allowed
}
const readScope = (resourceId = agent, type = "agent") => ({
  version: 1,
  resources: [{ type, id: resourceId, operations: ["read"] }],
})
async function support(resourceId = agent, type = "agent") {
  await actor()
  return command("support.approve", {
    staffId,
    reason: "Review requested",
    scope: readScope(resourceId, type),
    expiresAt: future(),
  })
}
beforeAll(async () => {
  await db.exec(`CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE ROLE agentonic_admin NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_customer NOSUPERUSER NOBYPASSRLS; CREATE ROLE agentonic_worker NOSUPERUSER NOBYPASSRLS;
  CREATE SCHEMA agentonic_bootstrap;
  CREATE FUNCTION agentonic_bootstrap.link_auth_users() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path='' AS $f$ ALTER TABLE agentonic.users ADD CONSTRAINT users_auth_user_fk FOREIGN KEY(auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT; $f$;`)
  for (const migration of [
    "202609130001_identity",
    "202609130002_access",
    "202610080057_member_emails",
  ])
    await db.exec(
      readFileSync(
        `packages/database/prisma/migrations/${migration}/migration.sql`,
        "utf8"
      )
    )
  await db.exec("BEGIN")
  for (const user of [
    owner,
    other,
    colleague,
    viewer,
    admin,
    staff,
    billing,
    newcomer,
  ]) {
    await db.query("INSERT INTO auth.users VALUES($1)", [user])
    if (user !== newcomer)
      await db.query(
        "INSERT INTO agentonic.users(id,auth_user_id,display_name) VALUES($1,$1,'Synthetic person')",
        [user]
      )
  }
  for (const [w, slug] of [
    [wa, "a"],
    [wb, "b"],
  ])
    await db.query(
      `INSERT INTO agentonic.workspaces(id,kind,name,slug,timezone,retention_policy) VALUES($1,'organization','Synthetic',$2,'UTC','{"conversationsDays":7,"checkpointsDays":7,"memoryDays":7,"sourcesDays":7,"logsDays":7,"auditDays":30,"backupsDays":7}')`,
      [w, slug]
    )
  for (const [user, w, role] of [
    [owner, wa, "owner"],
    [other, wb, "owner"],
    [colleague, wa, "member"],
    [viewer, wa, "viewer"],
    [admin, wa, "admin"],
  ])
    await db.query(
      "INSERT INTO agentonic.workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,$4)",
      [member(user!), w, user, role]
    )
  await db.query(
    "INSERT INTO agentonic.platform_staff(id,user_id,role) VALUES($1,$2,'administrator'),($3,$4,'billing')",
    [staffId, staff, id(602), billing]
  )
  for (const [repo, version, workspace, visibility] of [
    [id(701), template, null, "platform"],
    [id(702), privateTemplate, wb, "workspace"],
  ]) {
    await db.query(
      "INSERT INTO agentonic.code_repositories(id,name,repository_url,visibility,workspace_id,provisioning_status,created_by_staff_id) VALUES($1,'Synthetic',$2,$3,$4,'ready',$5)",
      [repo, `https://example.invalid/${repo}`, visibility, workspace, staffId]
    )
    await db.query(
      "INSERT INTO agentonic.agent_templates(id,slug,name,code_repository_id) VALUES($1,$2,'Synthetic',$1)",
      [repo, repo]
    )
    await db.query(
      "INSERT INTO agentonic.template_versions(id,template_id,version,git_commit_sha,manifest_sha256,structure_manifest,runtime_contract_version) VALUES($1,$2,'test',repeat('a',40),repeat('b',64),'{}','test')",
      [version, repo]
    )
  }
  for (const [a, w, own, t] of [
    [agent, wa, owner, template],
    [privateAgent, wb, other, privateTemplate],
  ])
    await db.query(
      "INSERT INTO agentonic.agents(id,workspace_id,name,slug,description,owner_member_id,template_version_id,created_by_member_id) VALUES($1,$2,'Synthetic','synthetic','Private instructions',$3,$4,$3)",
      [a, w, member(own!), t]
    )
  await db.query(
    "INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,description,owner_member_id) VALUES($1,$2,'Private library','private','Private knowledge',$3)",
    [collection, wa, member(owner)]
  )
  await db.query(
    "INSERT INTO agentonic.contacts(id,workspace_id,display_name) VALUES($1,$2,'External person')",
    [contact, wa]
  )
  await db.exec("COMMIT")
}, 30_000)
beforeEach(() => db.exec("BEGIN"))
afterEach(() => db.exec("ROLLBACK"))
afterAll(() => db.close())

describe("deny-by-default resource access", () => {
  it("all 16 tables have RLS and app roles cannot own or write them", async () => {
    const tables = await db.query<{ tablename: string; rowsecurity: boolean }>(
      "SELECT tablename,rowsecurity FROM pg_tables WHERE schemaname='agentonic'"
    )
    expect(tables.rows).toHaveLength(16)
    for (const t of tables.rows) {
      expect(t.rowsecurity).toBe(true)
      const p = await db.query<{ can_write: boolean }>(
        "SELECT has_table_privilege('agentonic_customer',$1,'INSERT,UPDATE,DELETE,TRUNCATE') AS can_write",
        [`agentonic.${t.tablename}`]
      )
      expect(p.rows[0]!.can_write).toBe(false)
    }
  })
  for (const who of [colleague, viewer, admin, staff])
    it(`membership/staff does not expose another owner's resources: ${who.slice(-1)}`, async () => {
      await actor(
        who,
        wa,
        who === staff ? "agentonic_admin" : "agentonic_customer"
      )
      expect((await db.query("SELECT * FROM agentonic.agents")).rows).toEqual(
        []
      )
      expect(
        (await db.query("SELECT * FROM agentonic.knowledge_collections")).rows
      ).toEqual([])
    })
  it("missing/wrong workspace denies reads and absent actors cannot mutate", async () => {
    await actor(owner, wb)
    expect(await can("agent", privateAgent, "read")).toBe(false)
    await expect(
      command("collection.create", { name: "Denied", slug: "denied" })
    ).rejects.toThrow(/Access denied/)
    await actor(owner, null)
    expect((await db.query("SELECT * FROM agentonic.agents")).rows).toEqual([])
    await expect(command("agent.create", {})).rejects.toThrow(/Access denied/)
  })
  it("owners and admins can create drafts; members/viewers cannot", async () => {
    for (const who of [owner, admin, colleague, viewer]) {
      await actor(who)
      const r = await command("agent.create", {
        name: "New",
        slug: `new-${who.slice(-1)}`,
        templateVersionId: template,
      })
      expect(r.ok).toBe([owner, admin].includes(who))
      if (r.ok)
        expect(
          (
            await db.query<{ status: string }>(
              "SELECT status FROM agentonic.agents WHERE id=$1",
              [r.id]
            )
          ).rows[0]!.status
        ).toBe("draft")
    }
  })
  it("customers cannot request active status, arbitrary creator IDs, approval or deployment", async () => {
    await actor()
    for (const operation of [
      "agent.deploy",
      "submission.approve",
      "template.publish",
    ])
      expect((await command(operation)).ok).toBe(false)
    expect(
      (
        await command("agent.create", {
          name: "X",
          slug: "x",
          templateVersionId: template,
          status: "active",
        })
      ).ok
    ).toBe(false)
    expect(
      (
        await command("agent.create", {
          name: "X",
          slug: "x",
          templateVersionId: template,
          createdByStaffId: staffId,
        })
      ).ok
    ).toBe(false)
    expect(await can("agent", agent, "deploy")).toBe(false)
  })
  it("private catalog records and foreign templates remain isolated", async () => {
    await actor()
    expect(
      (await db.query("SELECT * FROM agentonic.code_repositories")).rows
    ).toHaveLength(1)
    expect(
      (await db.query("SELECT * FROM agentonic.template_versions")).rows
    ).toHaveLength(1)
    expect(
      (
        await command("agent.create", {
          name: "X",
          slug: "x",
          templateVersionId: privateTemplate,
        })
      ).ok
    ).toBe(false)
    await actor(other, wb)
    expect(
      (await db.query("SELECT * FROM agentonic.template_versions")).rows
    ).toHaveLength(2)
  })
  it("unready/deprecated catalog entries cannot create an agent", async () => {
    await ownerSql(
      "UPDATE agentonic.code_repositories SET provisioning_status='planned'"
    )
    await actor()
    expect(
      (
        await command("agent.create", {
          name: "X",
          slug: "x",
          templateVersionId: template,
        })
      ).ok
    ).toBe(false)
  })
  for (const [role, edit, invoke] of [
    ["viewer", false, false],
    ["operator", false, true],
    ["maintainer", true, true],
  ] as const)
    it(`agent ${role} has only its explicit capabilities`, async () => {
      await actor()
      expect(
        (
          await command("agent.share", {
            agentId: agent,
            memberId: member(colleague),
            role,
          })
        ).ok
      ).toBe(true)
      await actor(colleague)
      expect(await can("agent", agent, "read")).toBe(true)
      expect(await can("agent", agent, "edit")).toBe(edit)
      expect(await can("agent", agent, "invoke")).toBe(invoke)
      expect(await can("agent", agent, "share")).toBe(false)
      expect(await can("collection", collection, "read")).toBe(false)
      expect(
        (
          await command("agent.share", {
            agentId: agent,
            memberId: member(viewer),
            role: "maintainer",
          })
        ).ok
      ).toBe(false)
    })
  it("collection sharing is independent, and read cannot curate or share", async () => {
    await actor()
    expect(
      (
        await command("collection.share", {
          collectionId: collection,
          memberId: member(colleague),
          permission: "read",
        })
      ).ok
    ).toBe(true)
    await actor(colleague)
    expect(await can("collection", collection, "read")).toBe(true)
    expect(await can("collection", collection, "curate")).toBe(false)
    expect(await can("collection", collection, "share")).toBe(false)
    expect(await can("agent", agent, "read")).toBe(false)
    await actor()
    await command("collection.revoke", {
      collectionId: collection,
      memberId: member(colleague),
    })
    await actor(colleague)
    expect(await can("collection", collection, "read")).toBe(false)
  })
  it("rejects cross-workspace grants and owner assignments", async () => {
    await actor()
    expect(
      (
        await command("agent.share", {
          agentId: agent,
          memberId: member(other),
          role: "maintainer",
        })
      ).ok
    ).toBe(false)
    expect(
      (
        await command("agent.create", {
          name: "X",
          slug: "x",
          templateVersionId: template,
          ownerMemberId: member(other),
        })
      ).ok
    ).toBe(false)
    await db.exec("RESET ROLE")
    await expect(
      db.query(
        "INSERT INTO agentonic.agent_member_grants(workspace_id,agent_id,member_id,role,granted_by_member_id) VALUES($1,$2,$3,'viewer',$4)",
        [wa, privateAgent, member(colleague), member(owner)]
      )
    ).rejects.toThrow(/foreign key/)
  })
})

describe("scoped staff access and audit", () => {
  it("staff cannot grant itself support or create unapproved customer agents", async () => {
    await actor(staff, wa, "agentonic_admin")
    expect(
      (
        await command("support.approve", {
          staffId,
          reason: "Self",
          scope: readScope(),
          expiresAt: future(),
        })
      ).ok
    ).toBe(false)
    expect(
      (
        await command("agent.create", {
          name: "X",
          slug: "x",
          templateVersionId: template,
        })
      ).ok
    ).toBe(false)
  })
  it("exact support read is audited; a grant never opens direct table reads", async () => {
    const g = await support()
    expect(g.ok).toBe(true)
    await actor(staff, wa, "agentonic_admin")
    expect((await db.query("SELECT * FROM agentonic.agents")).rows).toEqual([])
    const r = await command("support.read", {
      grantId: g.id,
      resourceType: "agent",
      resourceId: agent,
    })
    expect(r.ok).toBe(true)
    expect(r.data).toMatchObject({ description: "Private instructions" })
    const audits = await ownerSql(
      "SELECT * FROM agentonic.audit_events WHERE action='support.read'"
    )
    expect(audits.rows).toHaveLength(1)
    expect(audits.rows[0]).toMatchObject({
      actor_user_id: staff,
      actor_member_id: null,
      support_access_grant_id: g.id,
      redacted_details: {},
    })
    expect(JSON.stringify(audits.rows)).not.toContain("Private instructions")
  })
  it("support is bound to resource, staff identity, workspace and admin application", async () => {
    const g = await support()
    for (const [who, workspace, appRole, kind, target] of [
      [staff, wa, "agentonic_admin", "collection", collection],
      [billing, wa, "agentonic_admin", "agent", agent],
      [owner, wa, "agentonic_admin", "agent", agent],
      [staff, wa, "agentonic_customer", "agent", agent],
      [staff, wb, "agentonic_admin", "agent", privateAgent],
    ]) {
      await actor(who!, workspace!, appRole!)
      if (
        (who === staff && appRole === "agentonic_customer") ||
        who === billing
      ) {
        await expect(
          command("support.read", {
            grantId: g.id,
            resourceType: kind,
            resourceId: target,
          })
        ).rejects.toThrow(/Access denied/)
        continue
      }
      expect(
        (
          await command("support.read", {
            grantId: g.id,
            resourceType: kind,
            resourceId: target,
          })
        ).ok
      ).toBe(false)
    }
  })
  it("expired grants stop access", async () => {
    const g = await support()
    await ownerSql(
      "ALTER TABLE agentonic.support_access_grants DISABLE TRIGGER validate_access_rows"
    )
    await db.query(
      "UPDATE agentonic.support_access_grants SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",
      [g.id]
    )
    await db.exec(
      "ALTER TABLE agentonic.support_access_grants ENABLE TRIGGER validate_access_rows"
    )
    await actor(staff, wa, "agentonic_admin")
    expect(
      (
        await command("support.read", {
          grantId: g.id,
          resourceType: "agent",
          resourceId: agent,
        })
      ).ok
    ).toBe(false)
  })
  it("revocation and staff disablement take effect immediately", async () => {
    const g = await support()
    await command("support.revoke", { grantId: g.id })
    await actor(staff, wa, "agentonic_admin")
    expect(
      (
        await command("support.read", {
          grantId: g.id,
          resourceType: "agent",
          resourceId: agent,
        })
      ).ok
    ).toBe(false)
    await ownerSql(
      "UPDATE agentonic.platform_staff SET disabled_at=now() WHERE id=$1",
      [staffId]
    )
    await actor(staff, wa, "agentonic_admin")
    await expect(
      command("support.read", {
        grantId: g.id,
        resourceType: "agent",
        resourceId: agent,
      })
    ).rejects.toThrow(/Access denied/)
  })
  for (const scope of [
    { version: 1, resources: [] },
    {
      version: 1,
      resources: [{ type: "agent", id: "*", operations: ["read"] }],
    },
    readScope(privateAgent),
    {
      version: 1,
      resources: [{ type: "agent", id: agent, operations: ["deploy"] }],
    },
  ])
    it(`rejects empty, wildcard, foreign or expanded scope: ${JSON.stringify(scope)}`, async () => {
      await actor()
      await expect(
        command("support.approve", {
          staffId,
          reason: "Test",
          scope,
          expiresAt: future(),
        })
      ).rejects.toThrow()
    })
  it("workspace administrators cannot delegate another owner's private resources", async () => {
    await actor(admin)
    await expect(
      command("support.approve", {
        staffId,
        reason: "Test",
        scope: readScope(),
        expiresAt: future(),
      })
    ).rejects.toThrow(/Invalid support resource/)
  })
  it("denied commands record safe audit entries and cannot forge actors", async () => {
    await actor(colleague)
    expect(
      (
        await command("agent.share", {
          agentId: agent,
          memberId: member(viewer),
          role: "maintainer",
        })
      ).ok
    ).toBe(false)
    const r = await ownerSql("SELECT * FROM agentonic.audit_events")
    expect(r.rows).toHaveLength(1)
    expect(r.rows[0]).toMatchObject({
      outcome: "denied",
      actor_user_id: colleague,
      resource_id: "request",
      redacted_details: {},
    })
  })
  it("audit and support history cannot be rewritten", async () => {
    const g = await support()
    await db.exec("RESET ROLE")
    await expect(
      db.query(
        "UPDATE agentonic.support_access_grants SET reason='rewritten' WHERE id=$1",
        [g.id]
      )
    ).rejects.toThrow(/immutable/)
  })
})

describe("contacts and offboarding", () => {
  it("empty external capabilities deny; contacts do not become panel members", async () => {
    await actor()
    await command("contact.grant", {
      agentId: agent,
      contactId: contact,
      capabilities: [],
    })
    await db.exec("RESET ROLE")
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "SELECT agentonic.can_contact_invoke($1,$2) AS allowed",
          [agent, contact]
        )
      ).rows[0]!.allowed
    ).toBe(false)
    await actor()
    await command("contact.grant", {
      agentId: agent,
      contactId: contact,
      capabilities: ["invoke"],
    })
    await db.exec("RESET ROLE")
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "SELECT agentonic.can_contact_invoke($1,$2) AS allowed",
          [agent, contact]
        )
      ).rows[0]!.allowed
    ).toBe(true)
    expect(
      (
        await db.query(
          "SELECT * FROM agentonic.workspace_members WHERE workspace_id=$1",
          [wa]
        )
      ).rows
    ).toHaveLength(4)
  })
  it("contact linking uses the current verified identity only", async () => {
    await actor(colleague)
    const c = await command("contact.ensure")
    expect(c.ok).toBe(true)
    expect((await command("contact.ensure", { linkedUserId: owner })).ok).toBe(
      false
    )
    expect(
      (
        await db.query(
          "SELECT linked_user_id FROM agentonic.contacts WHERE id=$1",
          [c.id]
        )
      ).rows[0]
    ).toEqual({ linked_user_id: colleague })
  })
  it("removal revokes member/contact grants and blocks surviving channel access", async () => {
    await actor(colleague)
    const c = await command("contact.ensure")
    await actor()
    await command("agent.share", {
      agentId: agent,
      memberId: member(colleague),
      role: "operator",
    })
    await command("collection.share", {
      collectionId: collection,
      memberId: member(colleague),
      permission: "read",
    })
    await command("contact.grant", {
      agentId: agent,
      contactId: c.id,
      capabilities: ["invoke"],
    })
    expect(
      (
        await command("member.update", {
          memberId: member(colleague),
          role: "member",
          status: "removed",
        })
      ).ok
    ).toBe(true)
    await actor(colleague)
    expect(await can("agent", agent, "invoke")).toBe(false)
    expect(await can("collection", collection, "read")).toBe(false)
    await db.exec("RESET ROLE")
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "SELECT agentonic.can_contact_invoke($1,$2) AS allowed",
          [agent, c.id]
        )
      ).rows[0]!.allowed
    ).toBe(false)
    expect(
      (
        await db.query<{ revoked_at: string | null }>(
          "SELECT revoked_at FROM agentonic.agent_contact_grants WHERE contact_id=$1",
          [c.id]
        )
      ).rows[0]!.revoked_at
    ).not.toBeNull()
  })
  it("suspension followed by reactivation does not resurrect grants", async () => {
    await actor()
    await command("agent.share", {
      agentId: agent,
      memberId: member(colleague),
      role: "operator",
    })
    await command("member.update", {
      memberId: member(colleague),
      role: "member",
      status: "suspended",
    })
    await command("member.update", {
      memberId: member(colleague),
      role: "member",
      status: "active",
    })
    await actor(colleague)
    expect(await can("agent", agent, "read")).toBe(false)
  })
  it("last owner cannot be removed, and denial is atomic", async () => {
    await actor()
    expect(
      (
        await command("member.update", {
          memberId: member(owner),
          role: "member",
          status: "removed",
          successorMemberId: member(admin),
        })
      ).ok
    ).toBe(false)
    expect(await can("agent", agent, "share")).toBe(true)
    expect(
      (await db.query("SELECT role,status FROM agentonic.workspace_members"))
        .rows
    ).toEqual([{ role: "owner", status: "active" }])
  })
  it("resource-owning member removal requires explicit succession; owner transfer is audited", async () => {
    await actor()
    const a = await command("agent.create", {
      name: "Colleague's",
      slug: "colleague",
      ownerMemberId: member(colleague),
      templateVersionId: template,
    })
    expect(
      (
        await command("member.update", {
          memberId: member(colleague),
          role: "member",
          status: "removed",
        })
      ).ok
    ).toBe(false)
    expect(
      (
        await command("member.update", {
          memberId: member(colleague),
          role: "member",
          status: "removed",
          successorMemberId: member(owner),
        })
      ).ok
    ).toBe(true)
    expect(await can("agent", a.id, "share")).toBe(true)
  })
  it("admin cannot promote itself or remove an owner, and active-member transfer cannot steal resources", async () => {
    await actor(admin)
    expect(
      (
        await command("member.update", {
          memberId: member(admin),
          role: "owner",
          status: "active",
        })
      ).ok
    ).toBe(false)
    expect(
      (
        await command("member.update", {
          memberId: member(owner),
          role: "member",
          status: "removed",
        })
      ).ok
    ).toBe(false)
    await actor()
    expect(
      (
        await command("member.update", {
          memberId: member(colleague),
          role: "member",
          status: "active",
          successorMemberId: member(owner),
        })
      ).ok
    ).toBe(false)
  })
})

describe("single-use verified-email invitations", () => {
  const tokenHash = "a".repeat(64)
  async function invite(role = "member") {
    await actor()
    return command("invite.issue", {
      email: "new@example.invalid",
      role,
      tokenHash,
      expiresAt: future(),
    })
  }
  it("accepts only the confirmed matching email, creates an application identity, and cannot replay", async () => {
    await invite()
    await actor(newcomer, wa, "agentonic_customer", "wrong@example.invalid")
    expect((await command("invite.accept", { tokenHash })).ok).toBe(false)
    await actor(newcomer, wa, "agentonic_customer", "new@example.invalid")
    expect((await command("invite.accept", { tokenHash })).ok).toBe(true)
    expect((await command("invite.accept", { tokenHash })).ok).toBe(false)
    expect(
      (await db.query("SELECT role FROM agentonic.workspace_members")).rows
    ).toEqual([{ role: "member" }])
    expect((await db.query("SELECT * FROM agentonic.agents")).rows).toEqual([])
    expect(
      (
        await ownerSql(
          "SELECT email FROM agentonic.users WHERE auth_user_id=$1",
          [newcomer]
        )
      ).rows
    ).toEqual([{ email: "new@example.invalid" }])
  })
  it("revoked invitations cannot be accepted", async () => {
    const i = await invite()
    await command("invite.revoke", { invitationId: i.id })
    await actor(newcomer, wa, "agentonic_customer", "new@example.invalid")
    expect((await command("invite.accept", { tokenHash })).ok).toBe(false)
  })
  it("invite hashes never appear in customer reads or audit", async () => {
    await invite()
    expect(
      (await db.query("SELECT * FROM agentonic.workspace_invitations")).rows
    ).toEqual([])
    expect(JSON.stringify((await command("invite.list")).data)).not.toContain(
      tokenHash
    )
    expect(
      JSON.stringify(
        (await db.query("SELECT * FROM agentonic.audit_events")).rows
      )
    ).not.toContain("new@example.invalid")
  })
  it("members cannot invite and admins cannot invite owners/admins", async () => {
    for (const who of [colleague, admin]) {
      await actor(who)
      expect(
        (
          await command("invite.issue", {
            email: "new@example.invalid",
            role: "admin",
            tokenHash,
            expiresAt: future(),
          })
        ).ok
      ).toBe(false)
    }
  })
  it("member directory is workspace-scoped and restricted to managers", async () => {
    await actor()
    const r = await command("member.list")
    expect(r.data).toHaveLength(4)
    expect(JSON.stringify(r.data)).not.toContain(member(other))
    await actor(colleague)
    expect((await command("member.list")).ok).toBe(false)
  })
  it("shows managers each member's address from their latest verified session", async () => {
    const emailOf = async (user: string) =>
      (
        await ownerSql(
          "SELECT email FROM agentonic.users WHERE auth_user_id=$1",
          [user]
        )
      ).rows[0]
    await actor(owner, wa, "agentonic_customer", "  Owner@Example.INVALID ")
    await db.query("SELECT agentonic.record_verified_email()")
    expect(await emailOf(owner)).toEqual({ email: "owner@example.invalid" })
    // No verified address, or a malformed one, changes nothing.
    for (const email of ["", "not-an-address"]) {
      await actor(owner, wa, "agentonic_customer", email)
      await db.query("SELECT agentonic.record_verified_email()")
    }
    expect(await emailOf(owner)).toEqual({ email: "owner@example.invalid" })
    // Workers cannot record one.
    await actor(owner, wa, "agentonic_worker", "worker@example.invalid")
    await db.exec("SAVEPOINT worker_email")
    await expect(
      db.query("SELECT agentonic.record_verified_email()")
    ).rejects.toThrow()
    await db.exec("ROLLBACK TO SAVEPOINT worker_email")
    await actor()
    const listed = (await command("member.list")).data as {
      id: string
      email: string | null
    }[]
    expect(listed.find((m) => m.id === member(owner))?.email).toBe(
      "owner@example.invalid"
    )
    expect(listed.find((m) => m.id === member(colleague))?.email).toBeNull()
  })
})
it("strict input contracts reject invented authority, wildcard scopes and deployment commands", () => {
  expect(
    accessCommand.safeParse({
      operation: "agent.deploy",
      workspaceId: wa,
      payload: {},
    }).success
  ).toBe(false)
  expect(
    accessCommand.safeParse({
      operation: "contact.ensure",
      workspaceId: wa,
      payload: { userId: owner },
    }).success
  ).toBe(false)
  expect(supportScope.safeParse(readScope()).success).toBe(true)
  expect(supportScope.safeParse({ version: 1, resources: [] }).success).toBe(
    false
  )
})

it("expired invitations are denied and can be replaced without duplicate live records", async () => {
  await actor()
  const payload = {
    email: "expired@example.invalid",
    role: "member",
    tokenHash: "b".repeat(64),
    expiresAt: future(),
  }
  const expired = await command("invite.issue", payload)
  await ownerSql(
    "ALTER TABLE agentonic.workspace_invitations DISABLE TRIGGER validate_access_rows"
  )
  await db.query(
    "UPDATE agentonic.workspace_invitations SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",
    [expired.id]
  )
  await db.exec(
    "ALTER TABLE agentonic.workspace_invitations ENABLE TRIGGER validate_access_rows"
  )
  await actor(newcomer, wa, "agentonic_customer", payload.email)
  expect(
    (await command("invite.accept", { tokenHash: payload.tokenHash })).ok
  ).toBe(false)
  await actor()
  expect(
    (await command("invite.issue", { ...payload, tokenHash: "c".repeat(64) }))
      .ok
  ).toBe(true)
  const rows = await ownerSql(
    "SELECT revoked_at FROM agentonic.workspace_invitations WHERE id=$1",
    [expired.id]
  )
  expect(rows.rows[0]).not.toMatchObject({ revoked_at: null })
})
it("an invitation stops working when its inviter loses management authority", async () => {
  await actor(admin)
  const tokenHash = "d".repeat(64)
  await command("invite.issue", {
    email: "new@example.invalid",
    role: "member",
    tokenHash,
    expiresAt: future(),
  })
  await actor()
  await command("member.update", {
    memberId: member(admin),
    role: "member",
    status: "active",
  })
  await actor(newcomer, wa, "agentonic_customer", "new@example.invalid")
  expect((await command("invite.accept", { tokenHash })).ok).toBe(false)
})
it("linked contacts need both member authority and explicit channel capabilities", async () => {
  await actor(colleague)
  const c = await command("contact.ensure")
  await actor()
  await command("agent.share", {
    agentId: agent,
    memberId: member(colleague),
    role: "operator",
  })
  await command("contact.grant", {
    agentId: agent,
    contactId: c.id,
    capabilities: [],
  })
  await actor(colleague)
  await db.exec("RESET ROLE")
  expect(
    (
      await db.query<{ allowed: boolean }>(
        "SELECT agentonic.can_contact_invoke($1,$2) AS allowed",
        [agent, c.id]
      )
    ).rows[0]!.allowed
  ).toBe(false)
})
it("billing staff and worker credentials have no support-content entry point", async () => {
  await actor(billing, wa, "agentonic_admin")
  await expect(
    command("support.read", {
      grantId: id(999),
      resourceType: "agent",
      resourceId: agent,
    })
  ).rejects.toThrow(/Access denied/)
  await actor(staff, wa, "agentonic_worker")
  await expect(
    db.query("SELECT agentonic.access_command('member.list','{}',$1)", [
      id(999),
    ])
  ).rejects.toThrow(/permission denied/)
})
it("even privileged audit insertion rejects mismatched human provenance", async () => {
  await expect(
    db.query(
      "INSERT INTO agentonic.audit_events(workspace_id,actor_user_id,actor_member_id,action,resource_type,resource_id,outcome) VALUES($1,$2,$3,'test','test','test','succeeded')",
      [wa, other, member(owner)]
    )
  ).rejects.toThrow(/Audit actor mismatch/)
})
