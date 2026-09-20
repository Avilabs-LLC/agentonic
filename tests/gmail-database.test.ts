import { afterEach, beforeEach, expect, it } from "vitest"
import { createRagFixture, id } from "../scripts/rag-benchmark/fixture"
let f: Awaited<ReturnType<typeof createRagFixture>>
beforeEach(async () => {
  f = await createRagFixture()
})
afterEach(async () => {
  await f.db.close()
})
async function command(
  operation: string,
  payload: Record<string, unknown> = {}
) {
  await f.db.exec("SAVEPOINT gmail_test")
  try {
    const r = await f.db.query<{ r: Record<string, unknown> }>(
      "SELECT agentonic.gmail_command($1,$2::jsonb) r",
      [operation, JSON.stringify(payload)]
    )
    await f.db.exec("RELEASE SAVEPOINT gmail_test")
    return r.rows[0]!.r
  } catch (e) {
    await f.db.exec(
      "ROLLBACK TO SAVEPOINT gmail_test; RELEASE SAVEPOINT gmail_test"
    )
    throw e
  }
}
async function connect() {
  const state = "a".repeat(64)
  await command("oauth.start", {
    agentId: id(20),
    connectionId: id(501),
    state,
    verifier: "encrypted",
  })
  await command("oauth.consume", { state })
  await command("oauth.finish", {
    state,
    account: "synthetic@example.invalid",
    credential: "encrypted",
  })
}
it("binds OAuth to actor and workspace, consumes state once, and defaults to zero agent capabilities", async () => {
  await connect()
  expect(await command("list", { agentId: id(20) })).toMatchObject({
    connections: [{ operations: [], status: "connected" }],
  })
  await expect(
    command("oauth.consume", { state: "a".repeat(64) })
  ).rejects.toThrow()
  await f.actor(id(2), id(11))
  await expect(
    command("disconnect", { connectionId: id(501) })
  ).rejects.toThrow()
  await expect(command("list", { agentId: id(20) })).rejects.toThrow()
})
it("requires explicit per-agent permission and a tool-capable frozen runtime", async () => {
  await connect()
  await command("permissions", {
    agentId: id(20),
    connectionId: id(501),
    operations: ["gmail.read"],
  })
  const requestedAccess = {
    version: 1,
    collectionIds: [],
    tools: [{ connectionId: id(501), operations: ["gmail.read"] }],
  }
  expect(
    (
      await f.command("draft.save", {
        agentId: id(20),
        revision: 0,
        content: {
          version: 1,
          systemPrompt:
            "Synthetic mailbox assistant. Read only explicitly authorized messages.",
          skills: [],
        },
        requestedAccess,
      })
    ).ok
  ).toBe(true)
  await expect(
    f.command("candidate.freeze", {
      agentId: id(20),
      revision: 1,
      codeReleaseId: id(40),
    })
  ).rejects.toThrow()
  await command("disconnect", { connectionId: id(501) })
  expect(
    (
      await f.command("draft.save", {
        agentId: id(20),
        revision: 1,
        content: {
          version: 1,
          systemPrompt:
            "Synthetic mailbox assistant. Read only explicitly authorized messages.",
          skills: [],
        },
        requestedAccess,
      })
    ).ok
  ).toBe(false)
})
it("blocks staff, direct table access and unbound execution", async () => {
  await connect()
  await expect(
    command("confirm", { id: id(666), hash: "a".repeat(64) })
  ).rejects.toThrow()
  await f.actor(id(3), id(10), "agentonic_admin")
  await expect(command("list", { agentId: id(20) })).rejects.toThrow()
})

async function rpc(fn: string, params: unknown[]) {
  await f.db.exec("SAVEPOINT preview_gmail_test")
  try {
    const r = await f.db.query<{ r: Record<string, unknown> }>(
      `SELECT agentonic.${fn}(${params.map((_, i) => `$${i + 1}`).join(",")}) r`,
      params
    )
    await f.db.exec("RELEASE SAVEPOINT preview_gmail_test")
    return r.rows[0]!.r
  } catch (e) {
    await f.db.exec(
      "ROLLBACK TO SAVEPOINT preview_gmail_test; RELEASE SAVEPOINT preview_gmail_test"
    )
    throw e
  }
}
async function privatePreview(enableTools = true) {
  await f.sql(
    `INSERT INTO agentonic.code_releases(id,version,template_version_id,git_commit_sha,artifact_sha256,registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,artifact_key,artifact_size_bytes,published_by_staff_id,execution_manifest)
    SELECT $1,'gmail-preview',template_version_id,repeat('d',40),repeat('e',64),registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,'gmail-preview',artifact_size_bytes,published_by_staff_id,'{"previewContract":"1","gmailContract":"1","model":"gpt-4.1-mini-2025-04-14"}' FROM agentonic.code_releases WHERE id=$2`,
    [id(41), id(40)]
  )
  await f.sql(
    `INSERT INTO agentonic.workspace_code_release_grants(workspace_id,code_release_id,granted_by_staff_id) VALUES($1,$2,$3)`,
    [id(10), id(41), id(3)]
  )
  await f.actor()
  await connect()
  await command("permissions", {
    agentId: id(20),
    connectionId: id(501),
    operations: ["gmail.search", "gmail.read", "gmail.send"],
  })
  expect(
    (
      await f.command("draft.save", {
        agentId: id(20),
        revision: 0,
        content: {
          version: 1,
          systemPrompt:
            "Synthetic mailbox assistant for isolated preview authorization tests.",
          skills: [],
        },
        requestedAccess: {
          version: 1,
          collectionIds: [],
          tools: [
            {
              connectionId: id(501),
              operations: ["gmail.search", "gmail.read", "gmail.send"],
            },
          ],
        },
      })
    ).ok
  ).toBe(true)
  const candidate = await f.command("candidate.freeze", {
    agentId: id(20),
    revision: 1,
    codeReleaseId: id(41),
  })
  async function preview(
    operation: string,
    payload: Record<string, unknown> = {}
  ) {
    await f.actor()
    return rpc("preview_command", [
      operation,
      JSON.stringify({ agentId: id(20), ...payload }),
    ])
  }
  const p = await preview("start", { candidateId: candidate.id, enableTools })
  expect(p.ok).toBe(true)
  await preview("turn", {
    previewId: p.id,
    query: "Read synthetic messages",
    requestKey: id(502),
  })
  const job = await f.claim()
  expect(job).toBeTruthy()
  async function tool(
    operation: string,
    payload: Record<string, unknown> = {},
    token = job.token
  ) {
    await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
    return rpc("gmail_preview_worker", [
      operation,
      job.id,
      token,
      JSON.stringify(payload),
    ])
  }
  async function propose() {
    return tool("gmail-propose", {
      connectionId: id(501),
      operation: "gmail.send",
      id: id(503),
      argumentsCiphertext: "opaque-message",
      hash: "a".repeat(64),
    })
  }
  return { p, job, tool, propose, preview }
}
it("allows explicitly enabled private preview reads and one-time confirmed writes without deployment", async () => {
  const p = await privatePreview()
  expect(
    await p.tool("gmail-read", {
      connectionId: id(501),
      operation: "gmail.read",
    })
  ).toMatchObject({ credential: "encrypted" })
  expect(await p.propose()).toMatchObject({ pendingApproval: true })
  await f.actor()
  expect(
    (
      await command("invocations", {
        conversationId: p.p.id,
        context: "preview",
      })
    ).items
  ).toHaveLength(1)
  await expect(
    command("invocations", { conversationId: p.p.id })
  ).rejects.toThrow()
  await expect(
    command("confirm", { id: id(503), hash: "b".repeat(64) })
  ).rejects.toThrow()
  expect(
    await command("confirm", { id: id(503), hash: "a".repeat(64) })
  ).toMatchObject({ operation: "gmail.send" })
  await expect(
    command("confirm", { id: id(503), hash: "a".repeat(64) })
  ).rejects.toThrow()
  await command("complete", {
    id: id(503),
    status: "uncertain",
    result: { code: "uncertain" },
  })
  await expect(
    command("confirm", { id: id(503), hash: "a".repeat(64) })
  ).rejects.toThrow()
})
it("keeps no-tool previews closed and refuses unknown scopes or lost leases", async () => {
  const p = await privatePreview(false)
  expect(await p.tool("gmail-tools")).toEqual({ tools: [] })
  await expect(
    p.tool("gmail-read", { connectionId: id(501), operation: "gmail.read" })
  ).rejects.toThrow()
  await expect(p.propose()).rejects.toThrow()
  await expect(p.tool("gmail-tools", {}, id(999))).rejects.toThrow()
})
it("blocks another member and staff, and scrubs pending writes on preview cancellation", async () => {
  const p = await privatePreview()
  await p.propose()
  await f.actor(id(2), id(11))
  await expect(
    command("invocations", { conversationId: p.p.id, context: "preview" })
  ).rejects.toThrow()
  await expect(
    command("confirm", { id: id(503), hash: "a".repeat(64) })
  ).rejects.toThrow()
  await f.actor(id(3), id(10), "agentonic_admin")
  await expect(
    rpc("gmail_preview_worker", ["gmail-tools", p.job.id, p.job.token, "{}"])
  ).rejects.toThrow()
  await p.preview("cancel", { previewId: p.p.id })
  await expect(
    p.tool("gmail-read", { connectionId: id(501), operation: "gmail.read" })
  ).rejects.toThrow()
  expect(
    (
      await f.sql(
        "SELECT status,arguments_ciphertext FROM agentonic.gmail_invocations WHERE id=$1",
        [id(503)]
      )
    ).rows
  ).toEqual([{ status: "cancelled", arguments_ciphertext: null }])
})
it("intersects live permissions with frozen scope and stops on disconnect", async () => {
  const p = await privatePreview()
  await p.propose()
  await expect(
    p.tool("gmail-read", {
      connectionId: id(501),
      operation: "gmail.drafts.read",
    })
  ).rejects.toThrow()
  await f.actor()
  await command("permissions", {
    agentId: id(20),
    connectionId: id(501),
    operations: ["gmail.search"],
  })
  await expect(
    p.tool("gmail-read", { connectionId: id(501), operation: "gmail.read" })
  ).rejects.toThrow()
  await f.actor()
  await expect(
    command("confirm", { id: id(503), hash: "a".repeat(64) })
  ).rejects.toThrow()
  await command("disconnect", { connectionId: id(501) })
  await expect(p.tool("gmail-tools")).rejects.toThrow()
})
it("expires pending writes with the preview and rejects reads after expiry", async () => {
  const p = await privatePreview()
  await p.propose()
  await f.sql(
    "UPDATE agentonic.agent_previews SET created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
    [p.p.id]
  )
  await expect(
    p.tool("gmail-read", { connectionId: id(501), operation: "gmail.read" })
  ).rejects.toThrow()
  await f.actor()
  await expect(
    command("confirm", { id: id(503), hash: "a".repeat(64) })
  ).rejects.toThrow()
})
it("requires a new preview to opt into tools and never upgrades the existing session", async () => {
  const p = await privatePreview(false)
  const row = (
    await f.sql(
      "SELECT configuration_release_id FROM agentonic.agent_previews WHERE id=$1",
      [p.p.id]
    )
  ).rows[0] as { configuration_release_id: string }
  const next = await p.preview("start", {
    candidateId: row.configuration_release_id,
    enableTools: true,
  })
  expect(next.id).not.toBe(p.p.id)
  expect(await p.preview("state", { previewId: p.p.id })).toMatchObject({
    toolsEnabled: false,
  })
  expect(await p.preview("state", { previewId: next.id })).toMatchObject({
    toolsEnabled: true,
  })
})
it("does not grant normal retrieval jobs Gmail authority", async () => {
  const p = await privatePreview()
  await f.sql(
    "UPDATE agentonic.background_jobs SET preview_id=NULL,turn_number=NULL,request_key=NULL,response_model='gpt-4.1-mini-2025-04-14',reasoning_effort=NULL WHERE id=$1",
    [p.job.id]
  )
  await expect(p.tool("gmail-tools")).rejects.toThrow()
})
