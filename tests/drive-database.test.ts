import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  createRagFixture,
  embedding,
  id,
  member,
} from "../scripts/rag-benchmark/fixture"
import { toolGrants } from "../packages/contracts/src/tools"

// Google Drive against the real database functions (architecture §62), with
// synthetic accounts and files only.
let f: Awaited<ReturnType<typeof createRagFixture>>
beforeEach(async () => {
  f = await createRagFixture()
})
afterEach(async () => {
  await f.db.close()
})
const agent = id(20),
  collection = id(30),
  tools = id(601),
  knowledge = id(602),
  driveCode = id(41)
const doc = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"
const sheet = "1SheetAbCdEfGhIjKlMnOpQrStUvWx"
async function rpc(fn: string, params: unknown[]) {
  await f.db.exec("SAVEPOINT drive_rpc")
  try {
    const r = await f.db.query<{ r: Record<string, unknown> }>(
      `SELECT agentonic.${fn}(${params.map((_, i) => `$${i + 1}`).join(",")}) r`,
      params
    )
    await f.db.exec("RELEASE SAVEPOINT drive_rpc")
    return r.rows[0]!.r
  } catch (e) {
    await f.db.exec("ROLLBACK TO SAVEPOINT drive_rpc; RELEASE SAVEPOINT drive_rpc")
    throw Object.assign(e as Error, {
      message: `${fn}(${String(params[0])}): ${(e as Error).message} ${(e as { where?: string }).where ?? ""}`,
    })
  }
}
const command = (operation: string, payload: Record<string, unknown> = {}) =>
  rpc("drive_command", [operation, JSON.stringify(payload)])
async function connect(
  purpose: "tools" | "knowledge" = "tools",
  connectionId = purpose === "tools" ? tools : knowledge,
  account = "Synthetic@Example.invalid",
  state = (purpose === "tools" ? "a" : "b").repeat(64)
) {
  await f.actor()
  await command("oauth.start", {
    purpose,
    ...(purpose === "tools" ? { agentId: agent } : {}),
    connectionId,
    state,
    verifier: "sealed-verifier",
  })
  await command("oauth.consume", { state })
  const target = await command("oauth.target", { state, account })
  await command("oauth.finish", {
    state,
    account,
    connectionId: target.connectionId,
    credential: "sealed-credential",
  })
  return String(target.connectionId)
}
async function driveRelease() {
  await f.sql(
    `INSERT INTO agentonic.code_releases(id,version,template_version_id,git_commit_sha,artifact_sha256,registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,artifact_key,artifact_size_bytes,published_by_staff_id,execution_manifest)
    SELECT $1,'drive',template_version_id,repeat('d',40),repeat('e',64),registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,'drive',artifact_size_bytes,published_by_staff_id,'{"previewContract":"1","gmailContract":"1","driveContract":"1","model":"gpt-4.1-mini-2025-04-14"}' FROM agentonic.code_releases WHERE id=$2`,
    [driveCode, id(40)]
  )
  await f.sql(
    "INSERT INTO agentonic.workspace_code_release_grants(workspace_id,code_release_id,granted_by_staff_id) VALUES($1,$2,$3)",
    [id(10), driveCode, id(3)]
  )
}
const draft = (operations: string[], revision = 0) =>
  f.command("draft.save", {
    agentId: agent,
    revision,
    content: {
      version: 1,
      systemPrompt:
        "Synthetic Drive assistant. Read only the files picked for it.",
      skills: [],
    },
    requestedAccess: {
      version: 1,
      collectionIds: [],
      tools: [{ driveConnectionId: tools, operations }],
    },
  })

describe("Drive tools", () => {
  it("binds OAuth to the member, consumes state once and starts with no operations", async () => {
    await connect()
    expect(await command("list", { agentId: agent })).toEqual({
      connections: [
        {
          id: tools,
          account: "synthetic@example.invalid",
          status: "connected",
          operations: [],
          files: [],
        },
      ],
    })
    await expect(command("oauth.consume", { state: "a".repeat(64) })).rejects.toThrow()
    // A finish must use the connection the target named.
    await command("oauth.start", {
      purpose: "tools",
      agentId: agent,
      connectionId: id(603),
      state: "c".repeat(64),
      verifier: "v",
    })
    await command("oauth.consume", { state: "c".repeat(64) })
    await expect(
      command("oauth.finish", {
        state: "c".repeat(64),
        account: "other@example.invalid",
        connectionId: tools,
        credential: "x",
      })
    ).rejects.toThrow()
    // Another workspace's member sees and changes nothing.
    await f.actor(id(2), id(11))
    await expect(command("list", { agentId: agent })).rejects.toThrow()
    await expect(command("disconnect", { connectionId: tools })).rejects.toThrow()
    // Staff never reach Drive commands.
    await f.actor(id(3), id(10), "agentonic_admin")
    await expect(command("list", { agentId: agent })).rejects.toThrow()
  })

  it("revives a connection when the same account connects again", async () => {
    await connect()
    await command("permissions", {
      agentId: agent,
      connectionId: tools,
      operations: ["drive.files.read"],
    })
    await command("files.add", {
      agentId: agent,
      connectionId: tools,
      files: [{ fileId: doc, name: "Plan", mimeType: "application/vnd.google-apps.document" }],
    })
    await command("reconnect", { connectionId: tools })
    // Same account, any letter case: the old connection comes back with its files and operations.
    expect(
      await connect("tools", id(604), "SYNTHETIC@example.invalid", "d".repeat(64))
    ).toBe(tools)
    const listed = (await command("list", { agentId: agent })).connections as Record<string, unknown>[]
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({
      status: "connected",
      operations: ["drive.files.read"],
      files: [{ fileId: doc, origin: "picked" }],
    })
  })

  it("keeps an agent's files to supported types, 25 files and its own connection", async () => {
    await connect()
    await expect(
      command("files.add", {
        agentId: agent,
        connectionId: tools,
        files: [{ fileId: doc, name: "Video", mimeType: "video/mp4" }],
      })
    ).rejects.toThrow()
    await expect(
      command("files.add", {
        agentId: agent,
        connectionId: tools,
        files: [{ fileId: "../etc", name: "Ruta", mimeType: "text/plain" }],
      })
    ).rejects.toThrow()
    const many = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => ({
        fileId: `fileSynthetic${String(i + from).padStart(4, "0")}`,
        name: `Archivo ${i + from}`,
        mimeType: "text/plain",
      }))
    expect(
      await command("files.add", { agentId: agent, connectionId: tools, files: many(20) })
    ).toEqual({ ok: true })
    expect(
      await command("files.add", { agentId: agent, connectionId: tools, files: many(6, 20) })
    ).toEqual({ ok: false, code: "too_many_files" })
    await command("files.remove", {
      agentId: agent,
      connectionId: tools,
      fileId: "fileSynthetic0000",
    })
    expect(
      ((await command("list", { agentId: agent })).connections as { files: unknown[] }[])[0]!.files
    ).toHaveLength(19)
  })

  it("requires explicit permission and a Drive runtime, and a disconnect ends the grant", async () => {
    await driveRelease()
    await f.actor()
    await connect()
    // Connecting granted nothing.
    expect((await draft(["drive.files.read"])).ok).toBe(false)
    await command("permissions", {
      agentId: agent,
      connectionId: tools,
      operations: ["drive.files.read", "drive.docs.create"],
    })
    await expect(
      command("permissions", {
        agentId: agent,
        connectionId: tools,
        operations: ["drive.files.delete"],
      })
    ).rejects.toThrow()
    expect((await draft(["drive.files.read"])).ok).toBe(true)
    // A runtime without driveContract cannot freeze Drive tools.
    await expect(
      f.command("candidate.freeze", { agentId: agent, revision: 1, codeReleaseId: id(40) })
    ).rejects.toThrow()
    const frozen = await f.command("candidate.freeze", {
      agentId: agent,
      revision: 1,
      codeReleaseId: driveCode,
    })
    expect(frozen.ok).toBe(true)
    expect(
      (
        await f.sql(
          "SELECT k.name,t.effective_policy->>'connectionId' connection FROM agentonic.configuration_tools t JOIN agentonic.code_tools k ON k.id=t.code_tool_id WHERE t.configuration_release_id=$1 AND k.package_key='drive-v1'",
          [frozen.id]
        )
      ).rows
    ).toEqual([{ name: "drive.files.read", connection: tools }])
    await f.actor()
    await command("disconnect", { connectionId: tools })
    expect((await draft(["drive.files.read"], 1)).ok).toBe(false)
  })

  async function preview(operations = ["drive.files.list", "drive.files.read", "drive.docs.create", "drive.docs.update"], enableTools = true) {
    await driveRelease()
    await f.actor()
    await connect()
    await command("permissions", { agentId: agent, connectionId: tools, operations })
    await command("files.add", {
      agentId: agent,
      connectionId: tools,
      files: [
        { fileId: doc, name: "Plan de lanzamiento", mimeType: "application/vnd.google-apps.document" },
        { fileId: sheet, name: "Presupuesto", mimeType: "application/vnd.google-apps.spreadsheet" },
      ],
    })
    expect((await draft(operations)).ok).toBe(true)
    const candidate = await f.command("candidate.freeze", {
      agentId: agent,
      revision: 1,
      codeReleaseId: driveCode,
    })
    const start = async (op: string, payload: Record<string, unknown>) => {
      await f.actor()
      return rpc("preview_command", [op, JSON.stringify({ agentId: agent, ...payload })])
    }
    const p = await start("start", { candidateId: candidate.id, enableTools })
    expect(p.ok).toBe(true)
    await start("turn", { previewId: p.id, query: "Lee el plan", requestKey: id(605) })
    const job = await f.claim()
    const tool = async (operation: string, payload: Record<string, unknown> = {}, token = job.token) => {
      await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
      return rpc("drive_preview_worker", [operation, job.id, token, JSON.stringify(payload)])
    }
    const propose = (n: number, operation = "drive.docs.create", extra: Record<string, unknown> = {}) =>
      tool("drive-propose", {
        connectionId: tools,
        operation,
        id: id(n),
        argumentsCiphertext: "sealed-arguments",
        hash: "a".repeat(64),
        ...extra,
      })
    return { p, job, tool, propose, start }
  }

  it("reads with the agent's files and proposes writes confirmed once in a private preview", async () => {
    const p = await preview()
    expect(await p.tool("drive-tools")).toEqual({
      tools: [
        {
          driveConnectionId: tools,
          operations: ["drive.files.list", "drive.files.read", "drive.docs.create", "drive.docs.update"],
        },
      ],
    })
    expect(
      await p.tool("drive-read", { connectionId: tools, operation: "drive.files.read" })
    ).toEqual({
      credential: "sealed-credential",
      account: "synthetic@example.invalid",
      files: [
        { fileId: doc, name: "Plan de lanzamiento", mimeType: "application/vnd.google-apps.document" },
        { fileId: sheet, name: "Presupuesto", mimeType: "application/vnd.google-apps.spreadsheet" },
      ],
    })
    expect(
      await p.tool("drive-check", { connectionId: tools, operation: "drive.files.read", fileId: doc })
    ).toEqual({ ok: true })
    await expect(
      p.tool("drive-check", { connectionId: tools, operation: "drive.files.read", fileId: "notPickedFile123" })
    ).rejects.toThrow()
    expect(await p.propose(606)).toEqual({ pendingApproval: true, id: id(606), automatic: false })
    // An update names an allowlisted Google Doc; a sheet or an unpicked file is refused.
    await expect(p.propose(607, "drive.docs.update")).rejects.toThrow()
    await expect(p.propose(607, "drive.docs.update", { fileId: sheet })).rejects.toThrow()
    await expect(p.propose(607, "drive.docs.update", { fileId: "notPickedFile123" })).rejects.toThrow()
    expect(await p.propose(607, "drive.docs.update", { fileId: doc })).toMatchObject({ pendingApproval: true })
    await f.actor()
    const listed = (await command("invocations", { conversationId: p.p.id, context: "preview" })).items as Record<string, unknown>[]
    expect(listed.map((i) => [i.operation, i.status, i.argumentsCiphertext])).toEqual([
      ["drive.docs.create", "pending", "sealed-arguments"],
      ["drive.docs.update", "pending", "sealed-arguments"],
    ])
    // Staging listing never shows preview proposals.
    await expect(command("invocations", { conversationId: p.p.id })).rejects.toThrow()
    await expect(command("confirm", { id: id(606), hash: "b".repeat(64) })).rejects.toThrow()
    expect(await command("confirm", { id: id(606), hash: "a".repeat(64) })).toMatchObject({
      operation: "drive.docs.create",
      credential: "sealed-credential",
      argumentsCiphertext: "sealed-arguments",
      fileId: null,
    })
    await expect(command("confirm", { id: id(606), hash: "a".repeat(64) })).rejects.toThrow()
    await command("complete", {
      id: id(606),
      status: "succeeded",
      result: { fileId: "1NewDocAbCdEfGhIjKlMnOp", name: "Resumen", body: "never kept" },
    })
    await expect(
      command("complete", { id: id(606), status: "succeeded", result: {} })
    ).rejects.toThrow()
    // The created Doc joins the agent's files; the result keeps only its ID and link.
    expect(
      (
        await f.sql(
          "SELECT status,arguments_ciphertext,result FROM agentonic.drive_invocations WHERE id=$1",
          [id(606)]
        )
      ).rows
    ).toEqual([
      {
        status: "succeeded",
        arguments_ciphertext: null,
        result: {
          fileId: "1NewDocAbCdEfGhIjKlMnOp",
          url: "https://docs.google.com/document/d/1NewDocAbCdEfGhIjKlMnOp/edit",
        },
      },
    ])
    await f.actor()
    const files = ((await command("list", { agentId: agent })).connections as { files: { fileId: string; origin: string }[] }[])[0]!.files
    expect(files.map((x) => [x.fileId, x.origin])).toContainEqual(["1NewDocAbCdEfGhIjKlMnOp", "created"])
    // An update names its file, so removing it from the agent stops the update.
    expect(await command("inspect", { id: id(607), hash: "a".repeat(64) })).toMatchObject({ fileId: doc })
    await command("files.remove", { agentId: agent, connectionId: tools, fileId: doc })
    await expect(command("confirm", { id: id(607), hash: "a".repeat(64) })).rejects.toThrow()
  })

  it("keeps no-tool previews closed, refuses lost leases, other members and staff, and scrubs on cancel", async () => {
    const closed = await preview(undefined, false)
    expect(await closed.tool("drive-tools")).toEqual({ tools: [] })
    await expect(
      closed.tool("drive-read", { connectionId: tools, operation: "drive.files.read" })
    ).rejects.toThrow()
    await expect(closed.tool("drive-tools", {}, id(999))).rejects.toThrow()
  })

  it("scrubs a preview's pending writes when it ends, and blocks other members", async () => {
    const p = await preview()
    await p.propose(608)
    await f.actor(id(2), id(11))
    await expect(command("invocations", { conversationId: p.p.id, context: "preview" })).rejects.toThrow()
    await expect(command("confirm", { id: id(608), hash: "a".repeat(64) })).rejects.toThrow()
    await p.start("cancel", { previewId: p.p.id })
    expect(
      (await f.sql("SELECT status,arguments_ciphertext FROM agentonic.drive_invocations WHERE id=$1", [id(608)])).rows
    ).toEqual([{ status: "cancelled", arguments_ciphertext: null }])
  })

  it("intersects live permissions with the frozen scope and stops on disconnect", async () => {
    const p = await preview()
    await p.propose(609)
    await f.actor()
    await command("permissions", { agentId: agent, connectionId: tools, operations: ["drive.files.list"] })
    await expect(
      p.tool("drive-read", { connectionId: tools, operation: "drive.files.read" })
    ).rejects.toThrow()
    await f.actor()
    await expect(command("confirm", { id: id(609), hash: "a".repeat(64) })).rejects.toThrow()
    await command("disconnect", { connectionId: tools })
    expect(
      (await f.sql("SELECT status,arguments_ciphertext FROM agentonic.drive_invocations WHERE id=$1", [id(609)])).rows
    ).toEqual([{ status: "cancelled", arguments_ciphertext: null }])
    expect((await f.sql("SELECT count(*)::int n FROM agentonic.drive_files")).rows).toEqual([{ n: 0 }])
  })

  it("expires pending writes with the preview and in the retention sweep", async () => {
    const p = await preview()
    await p.propose(610)
    await f.sql(
      "UPDATE agentonic.drive_invocations SET created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
      [id(610)]
    )
    await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
    expect(await rpc("drive_retention_sweep", [])).toMatchObject({ expired: 1 })
    expect(
      (await f.sql("SELECT status,arguments_ciphertext FROM agentonic.drive_invocations WHERE id=$1", [id(610)])).rows
    ).toEqual([{ status: "expired", arguments_ciphertext: null }])
  })

  it("keeps the general connection, grant and tool call in step", async () => {
    const p = await preview()
    await p.propose(611)
    await f.actor()
    await command("confirm", { id: id(611), hash: "a".repeat(64) })
    await command("complete", { id: id(611), status: "uncertain", result: { code: "uncertain" } })
    expect(
      (
        await f.sql(
          "SELECT c.provider,c.status,c.secret_reference,c.configuration->>'purpose' purpose,g.allowed_operations FROM agentonic.connections c JOIN agentonic.agent_connection_grants g ON g.connection_id=c.id WHERE c.id=$1",
          [tools]
        )
      ).rows
    ).toEqual([
      {
        provider: "google_drive",
        status: "active",
        secret_reference: `drive_connections:${tools}`,
        purpose: "tools",
        allowed_operations: ["drive.files.list", "drive.files.read", "drive.docs.create", "drive.docs.update"],
      },
    ])
    expect(
      (
        await f.sql(
          "SELECT i.status,i.authorization_kind,i.redacted_result,a.decision,a.consumed_at IS NOT NULL consumed FROM agentonic.tool_invocations i JOIN agentonic.tool_approvals a ON a.tool_invocation_id=i.id WHERE i.id=$1",
          [id(611)]
        )
      ).rows
    ).toEqual([
      { status: "unknown", authorization_kind: "one_off", redacted_result: { code: "uncertain" }, decision: "approved", consumed: true },
    ])
    // A knowledge account is a connection with no agent grant.
    await connect("knowledge")
    expect(
      (await f.sql("SELECT count(*)::int n FROM agentonic.agent_connection_grants WHERE connection_id=$1", [knowledge])).rows
    ).toEqual([{ n: 0 }])
    await f.actor()
    await command("disconnect", { connectionId: tools })
    expect(
      (
        await f.sql(
          "SELECT c.status,g.revoked_at IS NOT NULL revoked,g.allowed_operations FROM agentonic.connections c JOIN agentonic.agent_connection_grants g ON g.connection_id=c.id WHERE c.id=$1",
          [tools]
        )
      ).rows
    ).toEqual([{ status: "revoked", revoked: true, allowed_operations: [] }])
  })

  it("revokes at Google only when no other connection holds the same account", async () => {
    await connect()
    await f.sql(
      "INSERT INTO agentonic.gmail_connections(id,workspace_id,agent_id,owner_member_id,account,credential_ciphertext) VALUES($1,$2,$3,$4,'synthetic@example.invalid','sealed')",
      [id(612), id(10), agent, member]
    )
    await f.actor()
    await command("disconnect", { connectionId: tools })
    expect(await rpc("google_account_shared", ["drive", tools])).toBe(true)
    expect(await rpc("google_account_shared", ["gmail", id(612)])).toBe(false)
    // Only the connection's own member may ask.
    await f.actor(id(2), id(11))
    await expect(rpc("google_account_shared", ["drive", tools])).rejects.toThrow()
  })

  it("admits one Drive grant beside Gmail and web in a version's access", async () => {
    const drive = { driveConnectionId: tools, operations: ["drive.files.read"] }
    const gmail = { connectionId: id(612), operations: ["gmail.read"] }
    const web = { capability: "web", operations: ["web.search", "web.read"] }
    expect(toolGrants.safeParse([gmail, drive, web]).success).toBe(true)
    expect(toolGrants.safeParse([drive, drive]).success).toBe(false)
    const valid = async (value: unknown) =>
      (
        (await f.sql("SELECT agentonic.valid_tools($1::jsonb) v", [JSON.stringify(value)])).rows[0] as { v: boolean }
      ).v
    expect(await valid([gmail, drive, web])).toBe(true)
    expect(await valid([drive, { ...drive, driveConnectionId: id(613) }])).toBe(false)
    expect(await valid([{ ...drive, operations: ["drive.files.delete"] }])).toBe(false)
    expect(await valid([{ ...drive, extra: true }])).toBe(false)
    // Gmail's readers ignore Drive grants.
    expect(
      (await f.sql("SELECT agentonic.gmail_grants($1::jsonb) g", [JSON.stringify([gmail, drive])])).rows
    ).toEqual([{ g: [gmail] }])
  })
})

describe("Drive knowledge", () => {
  type Job = { id: string; token: string; kind: string }
  async function sync(job: Job, operation: string, payload: Record<string, unknown> = {}) {
    await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
    return rpc("drive_sync_worker", [operation, job.id, job.token, JSON.stringify(payload)])
  }
  async function claim() {
    await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
    return (await rpc("knowledge_claim", ["{ingest}"])) as unknown as Job | null
  }
  async function imported() {
    // The fixture starts with no embedding budget.
    await f.sql("UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=1000000 WHERE provider='voyage'")
    await connect("knowledge")
    await f.actor()
    expect(
      await command("knowledge.add", {
        connectionId: knowledge,
        collectionId: collection,
        files: [{ fileId: doc, name: "Plan de lanzamiento", mimeType: "application/vnd.google-apps.document" }],
      })
    ).toEqual({ ok: true, added: 1 })
    const row = (
      await f.sql("SELECT source_id,document_id FROM agentonic.drive_knowledge_files WHERE file_id=$1", [doc])
    ).rows[0] as { source_id: string; document_id: string }
    await f.actor()
    return row
  }
  const files = async () => {
    await f.actor()
    return (await command("knowledge.list")).files as Record<string, unknown>[]
  }
  const text = "Aurora se lanza el 14 de noviembre."
  let reservations = 0
  beforeEach(() => {
    reservations = 0
  })
  async function publish(job: Job, version: string, body = text, sha = "a".repeat(64)) {
    const operation = id(700 + ++reservations)
    await sync(job, "reserve", { id: operation, provider: "voyage", model: "voyage-4", microusd: 10 })
    await sync(job, "settle", { id: operation, tokens: 10, microusd: 1 })
    return sync(job, "publish", {
      version,
      name: "Plan de lanzamiento",
      modifiedTime: "2026-10-09T12:00:00Z",
      contentSha256: sha,
      parser: "drive-export-v1",
      chunks: [{ text: body, locator: { page: 1, start: 0, end: body.length }, embedding }],
    })
  }

  it("imports picked files into a curated collection and indexes them in the documents lane", async () => {
    const source = await imported()
    // Unsupported formats and the same file twice are refused or skipped.
    await expect(
      command("knowledge.add", {
        connectionId: knowledge,
        collectionId: collection,
        files: [{ fileId: sheet, name: "Video", mimeType: "video/mp4" }],
      })
    ).rejects.toThrow()
    expect(
      await command("knowledge.add", {
        connectionId: knowledge,
        collectionId: collection,
        files: [{ fileId: doc, name: "Plan", mimeType: "application/vnd.google-apps.document" }],
      })
    ).toEqual({ ok: true, added: 0 })
    expect(await files()).toMatchObject([
      {
        sourceId: source.source_id,
        status: "queued",
        url: `https://docs.google.com/document/d/${doc}/edit`,
        account: "synthetic@example.invalid",
        canManage: true,
        chunkCount: 0,
      },
    ])
    const job = (await claim())!
    expect(job).toMatchObject({ kind: "drive_sync", lane: "ingest" })
    expect(await sync(job, "read")).toMatchObject({
      fileId: doc,
      credential: "sealed-credential",
      appliedVersion: null,
      indexed: false,
      held: false,
    })
    expect(await publish(job, "7")).toEqual({ ok: true, chunks: 1 })
    expect(await files()).toMatchObject([{ status: "synced", chunkCount: 1 }])
    // Spend is attributed to the ingestion of this source.
    expect(
      (
        await f.sql(
          "SELECT e.source,j.source_id FROM agentonic.usage_events e JOIN agentonic.ingestion_jobs j ON j.id=e.ingestion_job_id WHERE e.id=$1",
          [id(701)]
        )
      ).rows
    ).toEqual([{ source: "ingestion", source_id: source.source_id }])
    // A version's frozen knowledge includes the Drive source, which deployments may use.
    expect(
      (
        await f.sql(
          "SELECT agentonic.knowledge_source_usable(k) usable,k.kind,k.connection_id FROM agentonic.knowledge_sources k WHERE k.id=$1",
          [source.source_id]
        )
      ).rows
    ).toEqual([{ usable: true, kind: "google_drive", connection_id: knowledge }])
  })

  it("checks hourly, records unchanged files without spend and re-indexes changes", async () => {
    const source = await imported()
    const first = (await claim())!
    await publish(first, "7")
    // Nothing is due yet.
    await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
    expect(await rpc("drive_sync_tick", [])).toEqual({ queued: 0 })
    await f.sql("UPDATE agentonic.drive_knowledge_files SET next_check_at=clock_timestamp()-interval '1 minute'")
    await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
    expect(await rpc("drive_sync_tick", [])).toEqual({ queued: 1 })
    const second = (await claim())!
    expect(await sync(second, "read")).toMatchObject({ appliedVersion: "7", indexed: true, contentSha256: "a".repeat(64) })
    await sync(second, "unchanged", { version: "8", name: "Plan renombrado" })
    expect(await files()).toMatchObject([{ status: "synced", name: "Plan renombrado" }])
    // A real change replaces the text.
    await f.actor()
    await f.sql("UPDATE agentonic.drive_knowledge_files SET checked_at=clock_timestamp()-interval '2 minutes'")
    await f.actor()
    expect(await command("knowledge.sync", { sourceId: source.source_id })).toEqual({ ok: true })
    const third = (await claim())!
    await publish(third, "9", "Aurora se lanza el 21 de noviembre.", "b".repeat(64))
    expect(
      (
        await f.sql(
          "SELECT c.content FROM agentonic.document_chunks c JOIN agentonic.documents d ON d.active_version_id=c.document_version_id WHERE d.id=$1",
          [source.document_id]
        )
      ).rows
    ).toEqual([{ content: "Aurora se lanza el 21 de noviembre." }])
    expect(
      (await f.sql("SELECT count(*)::int n FROM agentonic.document_versions WHERE document_id=$1", [source.document_id])).rows
    ).toEqual([{ n: 1 }])
  })

  it("holds a change cited by a running version until the curator applies it", async () => {
    const source = await imported()
    await publish((await claim())!, "7")
    const chunk = (
      await f.sql(
        "SELECT c.id,c.content_sha256 FROM agentonic.document_chunks c JOIN agentonic.documents d ON d.active_version_id=c.document_version_id WHERE d.id=$1",
        [source.document_id]
      )
    ).rows[0] as { id: string; content_sha256: string }
    // A running deployment whose approval cited that passage.
    await f.db.exec(
      `RESET ROLE; SET session_replication_role=replica;
       INSERT INTO agentonic.deployments(workspace_id,agent_id,code_release_id,configuration_release_id,submission_id,approval_id,host_id,environment,authorized_by_member_id,request_id,budget_usd,authorized_until,evidence_sources)
       VALUES('${id(10)}','${agent}','${id(40)}','${id(901)}','${id(902)}','${id(903)}','${id(904)}','local','${member}','${id(905)}',1,clock_timestamp()+interval '1 day','[{"id":"${chunk.id}","hash":"${chunk.content_sha256}"}]');
       SET session_replication_role=origin;`
    )
    await f.sql("UPDATE agentonic.drive_knowledge_files SET checked_at=clock_timestamp()-interval '2 minutes'")
    await f.actor()
    await command("knowledge.sync", { sourceId: source.source_id })
    const job = (await claim())!
    expect(await sync(job, "read")).toMatchObject({ held: true })
    // Even a publish is recorded as held, and the cited text stays.
    expect(await publish(job, "9", "Aurora se retrasa.", "c".repeat(64))).toEqual({ ok: true, held: true })
    expect(await files()).toMatchObject([
      { status: "held", citedBy: [{ id: agent, name: "Synthetic agent" }], chunkCount: 1 },
    ])
    expect(
      (await f.sql("SELECT content FROM agentonic.document_chunks WHERE id=$1", [chunk.id])).rows
    ).toEqual([{ content: text }])
    // Applying it is the curator's decision; the next sync then publishes.
    await f.actor()
    await command("knowledge.apply", { sourceId: source.source_id })
    const applied = (await claim())!
    expect(await sync(applied, "read")).toMatchObject({ held: false })
    await publish(applied, "9", "Aurora se retrasa.", "c".repeat(64))
    expect(await files()).toMatchObject([{ status: "synced", citedBy: [] }])
    expect((await f.sql("SELECT count(*)::int n FROM agentonic.document_chunks WHERE id=$1", [chunk.id])).rows).toEqual([{ n: 0 }])
  })

  it("removes text Drive no longer shares, pauses on reconnect and purges on disconnect", async () => {
    const source = await imported()
    await publish((await claim())!, "7")
    await f.sql("UPDATE agentonic.drive_knowledge_files SET checked_at=clock_timestamp()-interval '2 minutes'")
    await f.actor()
    await command("knowledge.sync", { sourceId: source.source_id })
    const job = (await claim())!
    await expect(sync(job, "gone", { code: "deleted_by_magic" })).rejects.toThrow()
    await sync(job, "gone", { code: "trashed" })
    expect(await files()).toMatchObject([{ status: "unavailable", errorCode: "trashed", chunkCount: 0 }])
    // A refused token pauses syncing and keeps what was imported usable.
    await f.sql("UPDATE agentonic.drive_knowledge_files SET checked_at=clock_timestamp()-interval '2 minutes'")
    await f.actor()
    await command("knowledge.sync", { sourceId: source.source_id })
    const next = (await claim())!
    await sync(next, "reconnect")
    expect(
      (await f.sql("SELECT status,credential_ciphertext FROM agentonic.drive_connections WHERE id=$1", [knowledge])).rows
    ).toEqual([{ status: "reconnect", credential_ciphertext: null }])
    expect(
      (await f.sql("SELECT agentonic.knowledge_source_usable(k) u FROM agentonic.knowledge_sources k WHERE id=$1", [source.source_id])).rows
    ).toEqual([{ u: true }])
    await f.actor()
    expect(await command("knowledge.sync", { sourceId: source.source_id })).toEqual({ ok: false, code: "reconnect" })
    // Disconnecting removes the sources and everything derived from them.
    await command("disconnect", { connectionId: knowledge })
    expect(
      (
        await f.sql(
          "SELECT (SELECT count(*) FROM agentonic.knowledge_sources WHERE kind='google_drive')::int sources,(SELECT count(*) FROM agentonic.documents WHERE id=$1)::int documents,(SELECT count(*) FROM agentonic.drive_knowledge_files)::int files",
          [source.document_id]
        )
      ).rows
    ).toEqual([{ sources: 0, documents: 0, files: 0 }])
  })

  it("lets readers see imports without the curator's account, and only curators manage them", async () => {
    const source = await imported()
    // Another member who can only read the collection.
    await f.db.exec(
      `RESET ROLE; INSERT INTO auth.users VALUES('${id(4)}');
       INSERT INTO agentonic.users(id,auth_user_id,display_name) VALUES('${id(4)}','${id(4)}','Reader');
       INSERT INTO agentonic.workspace_members(id,workspace_id,user_id,role) VALUES('${id(104)}','${id(10)}','${id(4)}','member');
       INSERT INTO agentonic.collection_member_grants(workspace_id,collection_id,member_id,permission,granted_by_member_id) VALUES('${id(10)}','${collection}','${id(104)}','read','${member}');`
    )
    await f.actor(id(4), id(10))
    const seen = (await command("knowledge.list")).files as Record<string, unknown>[]
    expect(seen).toMatchObject([{ sourceId: source.source_id, account: null, canManage: false }])
    await expect(command("knowledge.remove", { sourceId: source.source_id })).rejects.toThrow()
    await expect(
      command("oauth.start", { purpose: "knowledge", connectionId: id(614), state: "e".repeat(64), verifier: "v" })
    ).rejects.toThrow()
    await f.actor()
    expect(await command("knowledge.remove", { sourceId: source.source_id })).toEqual({ ok: true })
    expect(await files()).toEqual([])
  })

  it("only syncs with the curator's connected account", async () => {
    const source = await imported()
    await f.actor()
    await command("reconnect", { connectionId: knowledge })
    // The queued sync can no longer be claimed; the claim drops it.
    expect(await claim()).toBeNull()
    expect(
      (await f.sql("SELECT status FROM agentonic.background_jobs WHERE kind='drive_sync'")).rows
    ).toEqual([{ status: "cancelled" }])
  })
})

describe("Drive evaluations", () => {
  it("adds Drive tool cases for a version that reads or creates Docs", async () => {
    const cases = (
      (
        await f.sql("SELECT agentonic.platform_tool_cases($1::jsonb) c", [
          JSON.stringify({
            tools: [{ driveConnectionId: tools, operations: ["drive.files.read", "drive.docs.create"] }],
          }),
        ])
      ).rows[0] as { c: { key: string; fixtures: { drive: unknown[] } }[] }
    ).c
    expect(cases.map((c) => c.key)).toEqual(["platform-drive-injection", "platform-drive-write"])
    expect(cases.every((c) => c.fixtures.drive.length > 0)).toBe(true)
  })
})
