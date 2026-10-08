import { afterEach, beforeEach, expect, it } from "vitest"
import { createRagFixture, id } from "../scripts/rag-benchmark/fixture"
// Aprender mi estilo (migration 61, architecture §57).
let f: Awaited<ReturnType<typeof createRagFixture>>
beforeEach(async () => {
  f = await createRagFixture()
})
afterEach(async () => {
  await f.db.close()
})
async function call<T = Record<string, unknown>>(
  sql: string,
  params: unknown[]
) {
  await f.db.exec("SAVEPOINT style_test")
  try {
    const r = await f.db.query<{ r: T }>(sql, params)
    await f.db.exec("RELEASE SAVEPOINT style_test")
    return r.rows[0]!.r
  } catch (e) {
    await f.db.exec(
      "ROLLBACK TO SAVEPOINT style_test; RELEASE SAVEPOINT style_test"
    )
    throw e
  }
}
const gmail = (operation: string, payload: Record<string, unknown>) =>
  call("SELECT agentonic.gmail_command($1,$2::jsonb) r", [
    operation,
    JSON.stringify(payload),
  ])
const style = (operation: string, payload: Record<string, unknown>) =>
  call("SELECT agentonic.style_guide_command($1,$2::jsonb,$3::uuid) r", [
    operation,
    JSON.stringify(payload),
    id(900),
  ])
const state = () =>
  call<{ guides: Record<string, unknown>[] }>(
    "SELECT agentonic.style_guide_state($1) r",
    [id(20)]
  )
type Job = { id: string; token: string; lane: string; connectionId: string }
async function asWorker() {
  await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
}
const claim = async () => {
  await asWorker()
  return call<Job | null>("SELECT agentonic.style_guide_claim() r", [])
}
const work = async (
  job: Job,
  operation: string,
  payload: Record<string, unknown> = {}
) => {
  await asWorker()
  return call(
    "SELECT agentonic.style_guide_worker($1,$2::uuid,$3::uuid,$4::jsonb) r",
    [operation, job.id, job.token, JSON.stringify(payload)]
  )
}
async function connect() {
  const state = "b".repeat(64)
  await f.actor()
  await gmail("oauth.start", {
    agentId: id(20),
    connectionId: id(501),
    state,
    verifier: "encrypted",
  })
  await gmail("oauth.consume", { state })
  await gmail("oauth.finish", {
    state,
    account: "synthetic@example.invalid",
    credential: "encrypted",
  })
}
const start = async (requestId = id(800), budgetUsd = 0.5) => {
  await f.actor()
  return style("start", {
    agentId: id(20),
    connectionId: id(501),
    budgetUsd,
    consent: true,
    requestId,
  })
}
const guide = "# Guía de estilo de escritura\n\n## Tono\n\nDirecto y cordial.\n"
/** Runs one guide to "ready" through the worker functions. */
async function ready(requestId = id(800)) {
  await start(requestId)
  const job = (await claim())!
  await work(job, "progress", {
    status: "reading",
    messagesRead: 0,
    messagesTotal: 12,
  })
  await work(job, "progress", {
    status: "analyzing",
    messagesRead: 12,
    messagesUsed: 10,
    batchesTotal: 1,
  })
  await work(job, "progress", { status: "writing", batchesDone: 1 })
  await work(job, "ready", { guide })
  return job
}

it("lets only the person who connected the account start a run, once at a time, with consent and a budget", async () => {
  await connect()
  await f.actor()
  await expect(
    style("start", {
      agentId: id(20),
      connectionId: id(501),
      budgetUsd: 0.5,
      consent: false,
      requestId: id(800),
    })
  ).rejects.toThrow()
  await expect(start(id(800), 0.1)).rejects.toThrow()
  const first = await start()
  expect(first).toMatchObject({ ok: true })
  // The same request returns the same run; another one waits for it to end.
  expect(await start()).toEqual(first)
  expect(await start(id(801))).toEqual({ ok: false, code: "busy" })
  expect((await state()).guides).toMatchObject([
    {
      id: first.id,
      connectionId: id(501),
      status: "queued",
      guide: null,
      budgetUsd: 0.5,
    },
  ])
  // Another member or workspace cannot start, read or cancel it.
  await f.actor(id(2), id(11))
  await expect(
    style("start", {
      agentId: id(20),
      connectionId: id(501),
      budgetUsd: 0.5,
      consent: true,
      requestId: id(802),
    })
  ).rejects.toThrow()
  await expect(state()).rejects.toThrow()
  await expect(style("cancel", { id: first.id })).rejects.toThrow()
})

it("runs in the worker's style lane under a lease and meters GPT-5.4 mini against its own budget", async () => {
  await connect()
  await f.db.exec("RESET ROLE")
  await f.db.query(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=25000000 WHERE provider='openai'"
  )
  await start(id(800), 0.25)
  const job = (await claim())!
  expect(job).toMatchObject({ lane: "style", connectionId: id(501) })
  expect(await claim()).toBeNull()
  expect(await work(job, "credential")).toEqual({
    credential: "encrypted",
    account: "synthetic@example.invalid",
    connectionId: id(501),
  })
  await expect(work({ ...job, token: id(899) }, "credential")).rejects.toThrow()
  await work(job, "progress", {
    status: "reading",
    messagesRead: 40,
    messagesTotal: 120,
  })
  await f.actor()
  expect((await state()).guides[0]).toMatchObject({
    status: "reading",
    messagesRead: 40,
    messagesTotal: 120,
  })
  await work(job, "progress", { status: "analyzing", batchesTotal: 8 })
  // Steps only move forward, and progress carries counts only.
  await expect(
    work(job, "progress", { status: "reading", messagesRead: 41 })
  ).rejects.toThrow()
  await expect(
    work(job, "progress", { status: "analyzing", text: "a message" })
  ).rejects.toThrow()
  await expect(
    work(job, "reserve", {
      id: id(810),
      provider: "openai",
      model: "gpt-5.4",
      microusd: 1000,
    })
  ).rejects.toThrow()
  expect(
    await work(job, "reserve", {
      id: id(811),
      provider: "openai",
      model: "gpt-5.4-mini",
      microusd: 100000,
    })
  ).toEqual({ ok: true })
  expect(
    await work(job, "reserve", {
      id: id(812),
      provider: "openai",
      model: "gpt-5.4-mini",
      microusd: 200000,
    })
  ).toEqual({ ok: false, code: "budget_exhausted" })
  // A guide cannot be recorded while a reservation is unsettled.
  await work(job, "progress", { status: "writing", batchesDone: 8 })
  await expect(work(job, "ready", { guide })).rejects.toThrow()
  await work(job, "settle", {
    id: id(811),
    tokens: 1000,
    outputTokens: 500,
    microusd: 3000,
  })
  await work(job, "ready", { guide })
  await f.actor()
  expect((await state()).guides[0]).toMatchObject({
    status: "ready",
    guide,
    committedMicrousd: 3000,
  })
  await f.db.exec("RESET ROLE")
  expect(
    (
      await f.db.query(
        "SELECT source,source_id,agent_id FROM agentonic.usage_events WHERE id=$1",
        [id(811)]
      )
    ).rows
  ).toEqual([{ source: "style_guide", source_id: job.id, agent_id: id(20) }])
})

it("adds an accepted guide as the person's own document and erases every draft it does not keep", async () => {
  await connect()
  const first = await ready()
  const objectId = await f.upload()
  await f.actor()
  expect(await style("accept", { id: first.id, objectId })).toMatchObject({
    ok: true,
  })
  expect((await state()).guides[0]).toMatchObject({
    status: "accepted",
    guide: null,
    document: { objectId, title: "fixture.md", collection: "Knowledge" },
  })
  // Discarding erases the draft.
  const second = await ready(id(801))
  await f.actor()
  await style("discard", { id: second.id })
  // A guide left past its review window is erased too.
  const third = await ready(id(802))
  await f.db.exec("RESET ROLE")
  await f.db.query(
    "UPDATE agentonic.style_guides SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [third.id]
  )
  await f.actor()
  expect((await state()).guides[0]).toMatchObject({
    status: "discarded",
    guide: null,
  })
  await f.actor()
  expect(await style("accept", { id: third.id, objectId })).toEqual({
    ok: false,
    code: "conflict",
  })
  await claim()
  await f.db.exec("RESET ROLE")
  expect(
    (
      await f.db.query(
        "SELECT status,guide FROM agentonic.style_guides WHERE id = ANY($1::uuid[]) ORDER BY created_at",
        [[second.id, third.id]]
      )
    ).rows
  ).toEqual([
    { status: "discarded", guide: null },
    { status: "discarded", guide: null },
  ])
})

it("fails without retrying when the lease lapses or the account is disconnected, and stops when cancelled", async () => {
  await connect()
  await start()
  const job = (await claim())!
  await f.db.exec("RESET ROLE")
  await f.db.query(
    "UPDATE agentonic.style_guides SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [job.id]
  )
  expect(await claim()).toBeNull()
  await f.actor()
  expect((await state()).guides[0]).toMatchObject({
    status: "failed",
    errorCode: "lease_lost",
  })
  await start(id(801))
  const cancelled = (await claim())!
  await f.actor()
  await style("cancel", { id: cancelled.id })
  await expect(work(cancelled, "heartbeat")).rejects.toThrow()
  await start(id(802))
  await f.actor()
  await gmail("disconnect", { connectionId: id(501) })
  expect(await claim()).toBeNull()
  await f.actor()
  expect((await state()).guides[0]).toMatchObject({
    status: "failed",
    errorCode: "reconnect",
  })
})

it("keeps the table private to its functions and refuses other roles", async () => {
  await connect()
  await start()
  await f.actor()
  await expect(
    call("SELECT count(*) r FROM agentonic.style_guides", [])
  ).rejects.toThrow()
  await expect(claim()).resolves.toBeTruthy()
  await f.actor(id(3), id(10), "agentonic_admin")
  await expect(state()).rejects.toThrow()
  await asWorker()
  await expect(
    call("SELECT agentonic.style_guide_command($1,$2::jsonb,$3::uuid) r", [
      "cancel",
      JSON.stringify({ id: id(1) }),
      id(900),
    ])
  ).rejects.toThrow()
})
