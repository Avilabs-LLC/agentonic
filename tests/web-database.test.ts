import { afterEach, beforeEach, expect, it } from "vitest"
import { createRagFixture, id } from "../scripts/rag-benchmark/fixture"
import { WEB_GRANT } from "../packages/contracts/src/web"
import { toolGrants } from "../packages/contracts/src/tools"
let f: Awaited<ReturnType<typeof createRagFixture>>
beforeEach(async () => {
  f = await createRagFixture()
})
afterEach(async () => {
  await f?.db.close()
})
async function rpc(fn: string, args: unknown[]) {
  await f.db.exec("SAVEPOINT web_test")
  try {
    const r = await f.db.query<{ r: Record<string, unknown> }>(
      `SELECT agentonic.${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) r`,
      args
    )
    await f.db.exec("RELEASE SAVEPOINT web_test")
    return r.rows[0]!.r
  } catch (e) {
    await f.db.exec(
      "ROLLBACK TO SAVEPOINT web_test; RELEASE SAVEPOINT web_test"
    )
    throw e
  }
}
const content = {
  version: 1,
  systemPrompt:
    "Synthetic public web research assistant for permission boundary tests.",
  skills: [],
}
async function prepared(webRuntime = true, research = true) {
  await f.sql(
    `INSERT INTO agentonic.code_releases(id,version,template_version_id,git_commit_sha,artifact_sha256,registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,artifact_key,artifact_size_bytes,published_by_staff_id,execution_manifest)
  SELECT $1,'web-preview',template_version_id,repeat('d',40),repeat('e',64),registry_sha256,runtime_contract_version,code_repository_id,artifact_bucket,'web-preview',artifact_size_bytes,published_by_staff_id,$3::jsonb FROM agentonic.code_releases WHERE id=$2`,
    [
      id(41),
      id(40),
      JSON.stringify({
        previewContract: "1",
        gmailContract: "1",
        ...(webRuntime ? { webContract: "1" } : {}),
        ...(research ? { webResearch: "1" } : {}),
        model: "gpt-4.1-mini-2025-04-14",
      }),
    ]
  )
  await f.sql(
    "INSERT INTO agentonic.workspace_code_release_grants(workspace_id,code_release_id,granted_by_staff_id) VALUES($1,$2,$3)",
    [id(10), id(41), id(3)]
  )
  await f.actor()
  expect(
    (
      await f.command("draft.save", {
        agentId: id(20),
        revision: 0,
        content,
        requestedAccess: { version: 1, collectionIds: [], tools: [WEB_GRANT] },
      })
    ).ok
  ).toBe(true)
  return f.command("candidate.freeze", {
    agentId: id(20),
    revision: 1,
    codeReleaseId: id(41),
  })
}
async function preview(enabled = true, research = true) {
  const candidate = await prepared(true, research)
  const p = await rpc("preview_command", [
    "start",
    JSON.stringify({
      agentId: id(20),
      candidateId: candidate.id,
      enableTools: enabled,
    }),
  ])
  await rpc("preview_command", [
    "turn",
    JSON.stringify({
      agentId: id(20),
      previewId: p.id,
      query: "Find public documentation",
      requestKey: id(501),
    }),
  ])
  const job = await f.claim()
  async function web(
    operation: string,
    payload: Record<string, unknown> = {},
    token = job.token
  ) {
    await f.db.exec("RESET ROLE;SET LOCAL ROLE agentonic_worker")
    return rpc("web_preview_worker", [
      operation,
      job.id,
      token,
      JSON.stringify(payload),
    ])
  }
  return { p, job, web }
}
it("validates web separately from connections and rejects arbitrary, duplicate or partial capability grants", async () => {
  const gmail = { connectionId: id(600), operations: ["gmail.read"] }
  expect(toolGrants.parse([WEB_GRANT, gmail])).toHaveLength(2)
  for (const tools of [
    [WEB_GRANT, WEB_GRANT],
    [{ capability: "web", operations: ["web.send"] }],
    [{ ...WEB_GRANT, apiKey: "forbidden" }],
    [{ capability: "web", operations: ["web.search"] }],
  ]) {
    expect(toolGrants.safeParse(tools).success).toBe(false)
    const r = await f.db.query<{ valid: boolean }>(
      "SELECT agentonic.valid_tools($1::jsonb) valid",
      [JSON.stringify(tools)]
    )
    expect(r.rows[0]!.valid).toBe(false)
  }
})
it("requires a web-capable frozen runtime", async () => {
  await expect(prepared(false)).rejects.toThrow("Web runtime required")
})
it("keeps opted-out previews closed even when the frozen version includes web", async () => {
  const p = await preview(false)
  expect(await p.web("web-tools")).toEqual({ enabled: false })
  await expect(
    p.web("web-reserve", { id: id(601), operation: "web.search" })
  ).rejects.toThrow()
})
it("reserves conservative web usage under both budgets and settles exactly once", async () => {
  const p = await preview()
  expect(await p.web("web-tools")).toEqual({ enabled: true })
  expect(
    await p.web("web-reserve", { id: id(601), operation: "web.search" })
  ).toEqual({ ok: false, code: "budget_exhausted" })
  await f.sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=100000 WHERE provider='browserbase'"
  )
  expect(
    await p.web("web-reserve", { id: id(601), operation: "web.search" })
  ).toEqual({ ok: true })
  expect(
    await p.web("web-settle", { id: id(601), operation: "web.search" })
  ).toEqual({ ok: true })
  await expect(
    p.web("web-settle", { id: id(601), operation: "web.search" })
  ).rejects.toThrow()
  const r = await f.sql<{ committed_microusd: number }>(
    "SELECT committed_microusd FROM agentonic.agent_previews WHERE id=$1",
    [p.p.id]
  )
  expect(Number(r.rows[0]!.committed_microusd)).toBe(7000)
  await f.sql(
    "UPDATE agentonic.agent_previews SET committed_microusd=249000 WHERE id=$1",
    [p.p.id]
  )
  expect(
    await p.web("web-reserve", { id: id(602), operation: "web.read" })
  ).toEqual({ ok: false, code: "budget_exhausted" })
})
it("bounds calls per turn, denies lost leases and rechecks revocation", async () => {
  const p = await preview()
  await f.sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=100000 WHERE provider='browserbase'"
  )
  await expect(p.web("web-check", {}, id(999))).rejects.toThrow()
  for (let n = 0; n < 8; n++) {
    await f.sql(
      "UPDATE agentonic.retrieval_provider_operations SET created_at=created_at-interval '2 seconds' WHERE provider='browserbase'"
    )
    expect(
      await p.web("web-reserve", { id: id(610 + n), operation: "web.read" })
    ).toEqual({ ok: true })
  }
  expect(
    await p.web("web-reserve", { id: id(618), operation: "web.read" })
  ).toEqual({ ok: false, code: "call_limit" })
  await f.actor()
  await f.command("draft.save", {
    agentId: id(20),
    revision: 1,
    content,
    requestedAccess: { version: 1, collectionIds: [], tools: [] },
  })
  await expect(p.web("web-check")).rejects.toThrow()
})
it("blocks staff, ordinary jobs and direct metering; web-only state has no Gmail approvals", async () => {
  const p = await preview()
  await f.actor()
  expect(
    await rpc("preview_command", [
      "state",
      JSON.stringify({ agentId: id(20), previewId: p.p.id }),
    ])
  ).toMatchObject({ gmailEnabled: false, toolsEnabled: true })
  for (const role of [
    "agentonic_customer",
    "agentonic_admin",
    "agentonic_eval_local",
  ]) {
    await f.db.exec(`RESET ROLE;SET LOCAL ROLE ${role}`)
    await expect(
      rpc("web_preview_worker", ["web-check", p.job.id, p.job.token, "{}"])
    ).rejects.toThrow()
  }
  await f.db.exec("RESET ROLE;SET LOCAL ROLE agentonic_worker")
  await expect(
    rpc("web_meter", [
      "web-reserve",
      p.job.id,
      id(10),
      id(20),
      p.p.id,
      null,
      null,
      JSON.stringify({ id: id(630), operation: "web.read" }),
    ])
  ).rejects.toThrow()
  await f.sql(
    "UPDATE agentonic.background_jobs SET preview_id=NULL,turn_number=NULL,request_key=NULL,response_model='gpt-4.1-mini-2025-04-14',reasoning_effort=NULL WHERE id=$1",
    [p.job.id]
  )
  await expect(p.web("web-tools")).rejects.toThrow()
})

it("preserves the three-call ceiling of previously published runtimes", async () => {
  const p = await preview(true, false)
  await f.sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=100000 WHERE provider='browserbase'"
  )
  for (let n = 0; n < 3; n++)
    expect(
      await p.web("web-reserve", { id: id(700 + n), operation: "web.read" })
    ).toEqual({ ok: true })
  expect(
    await p.web("web-reserve", { id: id(703), operation: "web.read" })
  ).toEqual({ ok: false, code: "call_limit" })
})
it("pins preview model per turn, meters the actual model and preserves retry identity", async () => {
  const candidate = await prepared()
  const p = await rpc("preview_command", [
    "start",
    JSON.stringify({
      agentId: id(20),
      candidateId: candidate.id,
      budgetUsd: 3,
    }),
  ])
  const payload = {
    agentId: id(20),
    previewId: p.id,
    query: "Compare sources",
    requestKey: id(750),
    model: "gpt-6-astra",
  }
  const queued = await rpc("preview_command", ["turn", JSON.stringify(payload)])
  expect(
    (await rpc("preview_command", ["turn", JSON.stringify(payload)])).id
  ).toBe(queued.id)
  expect(
    (
      await rpc("preview_command", [
        "turn",
        JSON.stringify({ ...payload, model: "gpt-4.1-mini-2025-04-14" }),
      ])
    ).code
  ).toBe("request_conflict")
  const job = await f.claim()
  await f.worker(job, "empty-search")
  expect((await f.worker(job, "context")).previewModel).toBe("gpt-6-astra")
  const worker = (operation: string, data: Record<string, unknown> = {}) =>
    rpc("rag_worker", [operation, job.id, job.token, JSON.stringify(data)])
  await expect(
    worker("reserve", {
      id: id(751),
      provider: "openai",
      model: "gpt-4.1-mini-2025-04-14",
      microusd: 100,
    })
  ).rejects.toThrow()
  await f.sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=10000000 WHERE provider='openai'"
  )
  await f.db.exec("RESET ROLE;SET LOCAL ROLE agentonic_worker")
  expect(
    (
      await worker("reserve", {
        id: id(751),
        provider: "openai",
        model: "gpt-6-astra",
        microusd: 1200000,
      })
    ).ok
  ).toBe(true)
  await worker("settle", {
    id: id(751),
    microusd: 11000,
    tokens: 100,
    outputTokens: 200,
  })
  await expect(
    worker("answer", {
      text: "No match.",
      citations: [],
      insufficientEvidence: true,
      model: "gpt-4.1-mini-2025-04-14",
    })
  ).rejects.toThrow()
  await worker("answer", {
    text: "No match.",
    citations: [],
    insufficientEvidence: true,
    model: "gpt-6-astra",
  })
  await f.actor()
  const state = await rpc("preview_command", [
    "state",
    JSON.stringify({ agentId: id(20), previewId: p.id }),
  ])
  expect(state.budgetUsd).toBe(3)
  expect(state.committedMicrousd).toBe(11000)
  expect(state.turns).toMatchObject([
    { model: "gpt-6-astra", answer: { model: "gpt-6-astra" } },
  ])
  await expect(
    rpc("preview_command", [
      "turn",
      JSON.stringify({
        ...payload,
        requestKey: id(752),
        model: "unreviewed-model",
      }),
    ])
  ).rejects.toThrow()
  // GPT-4.1 mini (§56), GPT-5.4 and GPT-5.4 mini (§77) are retired for new
  // test-chat turns, and this runtime predates the Codex models (§77).
  for (const [n, model] of [
    [753, "gpt-4.1-mini-2025-04-14"],
    [755, "gpt-5.4-mini"],
    [756, "gpt-5.4"],
    [757, "gpt-6-luna"],
  ] as const)
    await expect(
      rpc("preview_command", [
        "turn",
        JSON.stringify({ ...payload, requestKey: id(n), model }),
      ])
    ).rejects.toThrow()
  // A turn that names no model gets the one this runtime can run.
  await rpc("preview_command", [
    "turn",
    JSON.stringify({
      agentId: payload.agentId,
      previewId: payload.previewId,
      query: payload.query,
      requestKey: id(754),
    }),
  ])
  const next = await f.claim()
  await f.worker(next, "empty-search")
  expect(await f.worker(next, "context")).toMatchObject({
    previewModel: "gpt-6-astra",
    reasoningLevel: "low",
  })
  expect((await f.worker(next, "context")).history).toMatchObject([
    { answer: "No match." },
  ])
})
