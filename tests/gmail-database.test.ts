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
  // Claims carry the time the job was queued (migration 56, A2).
  expect(
    Date.parse(String((job as { queuedAt?: string }).queuedAt))
  ).toBeGreaterThan(0)
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
it("shows a preview turn's steps and refuses malformed ones (§74)", async () => {
  const p = await privatePreview()
  async function steps(value: unknown, token = p.job.token) {
    await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
    return rpc("rag_worker", [
      "steps",
      p.job.id,
      token,
      JSON.stringify({ steps: value }),
    ])
  }
  const step = {
    tool: "gmail.threads.read",
    target: "Cotización Q4",
    count: 5,
    status: "done",
  }
  expect(await steps([step])).toEqual({ ok: true })
  await expect(steps([{ ...step, status: "skipped" }])).rejects.toThrow()
  await expect(steps([step], id(599))).rejects.toThrow()
  expect(await p.preview("state", { previewId: p.p.id })).toMatchObject({
    turns: [{ steps: [step] }],
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

it("keeps the general conversation model in step with a private preview", async () => {
  const p = await privatePreview()
  const general = async () => ({
    conversation: (
      await f.sql(
        "SELECT c.environment,c.deleted_at IS NOT NULL closed,e.surface FROM agentonic.conversations c JOIN agentonic.channel_endpoints e ON e.id=c.endpoint_id WHERE c.id=$1",
        [p.p.id]
      )
    ).rows[0],
    runs: (
      await f.sql(
        "SELECT id,status,deployment_id,preview_id FROM agentonic.agent_runs WHERE conversation_id=$1",
        [p.p.id]
      )
    ).rows,
    messages: (
      await f.sql(
        "SELECT role,content,redacted_at IS NOT NULL redacted FROM agentonic.messages WHERE conversation_id=$1 ORDER BY sequence_number",
        [p.p.id]
      )
    ).rows,
  })
  // The preview is a conversation on the agent's preview surface; its turn is a
  // run with no deployment, sharing the job's ID.
  expect(await general()).toEqual({
    conversation: { environment: "staging", closed: false, surface: "preview" },
    runs: [
      {
        id: p.job.id,
        status: "running",
        deployment_id: null,
        preview_id: p.p.id,
      },
    ],
    messages: [
      {
        role: "user",
        content: { version: "1", text: "Read synthetic messages" },
        redacted: false,
      },
    ],
  })
  // Cancelling the preview closes the conversation and erases the turn's text.
  await p.preview("cancel", { previewId: p.p.id })
  const cancelled = await general()
  expect(cancelled.conversation).toMatchObject({ closed: true })
  expect(cancelled.messages).toEqual([
    { role: "user", content: { version: "1", redacted: true }, redacted: true },
  ])
  // Expired and cancelled previews' turns are deleted with their messages; the
  // run stays as the record of work.
  await f.claim().catch(() => null)
  expect((await general()).runs).toEqual([
    expect.objectContaining({ id: p.job.id, status: "cancelled" }),
  ])
  expect((await general()).messages).toEqual([])
})

it("keeps the general connection and grant in step with a Gmail connection", async () => {
  await connect()
  const general = async () => ({
    connection: (
      await f.sql(
        "SELECT provider,kind,status,external_account_id,secret_reference,environment,revoked_at IS NOT NULL revoked FROM agentonic.connections WHERE id=$1",
        [id(501)]
      )
    ).rows[0],
    grant: (
      await f.sql(
        "SELECT agent_id,allowed_operations,revoked_at IS NOT NULL revoked FROM agentonic.agent_connection_grants WHERE connection_id=$1",
        [id(501)]
      )
    ).rows[0],
  })
  expect(await general()).toEqual({
    connection: {
      provider: "google_gmail",
      kind: "oauth",
      status: "active",
      external_account_id: "synthetic@example.invalid",
      secret_reference: `gmail_connections:${id(501)}`,
      environment: "staging",
      revoked: false,
    },
    grant: { agent_id: id(20), allowed_operations: [], revoked: false },
  })
  await f.actor()
  await command("permissions", {
    agentId: id(20),
    connectionId: id(501),
    operations: ["gmail.read"],
  })
  expect((await general()).grant).toMatchObject({
    allowed_operations: ["gmail.read"],
  })
  await f.actor()
  await command("disconnect", { connectionId: id(501) })
  expect(await general()).toMatchObject({
    connection: { status: "revoked", revoked: true },
    grant: { allowed_operations: [], revoked: true },
  })
  // The sealed credential never crosses into the general model.
  const columns = (
    await f.sql(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='agentonic' AND table_name IN ('connections','agent_connection_grants','tool_invocations','tool_approvals') AND column_name LIKE '%cipher%'"
    )
  ).rows
  expect(columns).toEqual([])
})

it("records each Gmail write as a tool invocation with a one-time approval", async () => {
  const p = await privatePreview()
  await p.propose()
  const general = async () => ({
    invocation: (
      await f.sql(
        "SELECT i.run_id,i.status,i.authorization_kind,i.connection_id,i.redacted_arguments,i.redacted_result,i.error_code,k.name tool FROM agentonic.tool_invocations i JOIN agentonic.code_tools k ON k.id=i.code_tool_id WHERE i.id=$1",
        [id(503)]
      )
    ).rows[0],
    approval: (
      await f.sql(
        "SELECT decision,decided_at IS NOT NULL decided,consumed_at IS NOT NULL consumed FROM agentonic.tool_approvals WHERE tool_invocation_id=$1",
        [id(503)]
      )
    ).rows[0],
  })
  expect(await general()).toEqual({
    invocation: {
      run_id: p.job.id,
      status: "awaiting_approval",
      authorization_kind: "one_off",
      connection_id: id(501),
      redacted_arguments: null,
      redacted_result: null,
      error_code: null,
      tool: "gmail.send",
    },
    approval: { decision: "pending", decided: false, consumed: false },
  })
  await f.actor()
  await command("confirm", { id: id(503), hash: "a".repeat(64) })
  expect(await general()).toMatchObject({
    invocation: { status: "running" },
    approval: { decision: "approved", decided: true, consumed: true },
  })
  await f.actor()
  await command("complete", {
    id: id(503),
    status: "uncertain",
    result: { code: "uncertain" },
  })
  expect((await general()).invocation).toMatchObject({
    status: "unknown",
    redacted_result: { code: "uncertain" },
  })
  // A consumed approval cannot be reset, nor its invocation's arguments changed.
  for (const statement of [
    "UPDATE agentonic.tool_approvals SET consumed_at=NULL,decision='pending' WHERE tool_invocation_id=$1",
    "UPDATE agentonic.tool_invocations SET arguments_sha256=repeat('b',64) WHERE id=$1",
  ]) {
    await f.db.exec("SAVEPOINT reset_attempt")
    await expect(f.sql(statement, [id(503)])).rejects.toThrow()
    await f.db.exec("ROLLBACK TO SAVEPOINT reset_attempt")
  }
})

it("denies a cancelled Gmail write in the general model", async () => {
  const p = await privatePreview()
  await p.propose()
  await f.actor()
  await p.preview("cancel", { previewId: p.p.id })
  expect(
    (
      await f.sql(
        "SELECT i.status,i.error_code,a.decision FROM agentonic.tool_invocations i JOIN agentonic.tool_approvals a ON a.tool_invocation_id=i.id WHERE i.id=$1",
        [id(503)]
      )
    ).rows
  ).toEqual([
    { status: "denied", error_code: "cancelled", decision: "cancelled" },
  ])
})
it("sweeps expired Gmail data for every workspace, sparing writes still in flight", async () => {
  const p = await privatePreview()
  const propose = (n: number, hash: string) =>
    p.tool("gmail-propose", {
      connectionId: id(501),
      operation: "gmail.send",
      id: id(n),
      argumentsCiphertext: "opaque-message",
      hash: hash.repeat(64),
    })
  await propose(503, "a")
  await propose(504, "b")
  await propose(505, "c")
  await f.actor()
  await command("confirm", { id: id(504), hash: "b".repeat(64) })
  await command("confirm", { id: id(505), hash: "c".repeat(64) })
  // 503 is pending past its window; 504 has executed far past it (its worker
  // is gone); 505 is executing just past it and may still record an outcome.
  await f.sql(
    "UPDATE agentonic.gmail_invocations SET expires_at=clock_timestamp()-CASE id WHEN $1::uuid THEN interval '1 minute' WHEN $2::uuid THEN interval '20 minutes' ELSE interval '1 minute' END",
    [id(503), id(504)]
  )
  await f.sql(
    "UPDATE agentonic.gmail_oauth_states SET expires_at=clock_timestamp()-interval '2 hours'"
  )
  // Only the worker may sweep.
  await f.actor()
  await expect(rpc("gmail_retention_sweep", [])).rejects.toThrow()
  await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
  expect(await rpc("gmail_retention_sweep", [])).toEqual({
    expired: 1,
    uncertain: 1,
    oauthStates: 1,
  })
  expect(
    (
      await f.sql(
        "SELECT id,status,arguments_ciphertext IS NULL erased,arguments_sha256 IS NOT NULL audited FROM agentonic.gmail_invocations ORDER BY id"
      )
    ).rows
  ).toEqual([
    { id: id(503), status: "expired", erased: true, audited: true },
    { id: id(504), status: "uncertain", erased: true, audited: true },
    { id: id(505), status: "executing", erased: false, audited: true },
  ])
  // The in-flight write can still record its real outcome.
  await f.actor()
  await command("complete", {
    id: id(505),
    status: "succeeded",
    result: { code: "sent" },
  })
  await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
  expect(await rpc("gmail_retention_sweep", [])).toEqual({
    expired: 0,
    uncertain: 0,
    oauthStates: 0,
  })
})
