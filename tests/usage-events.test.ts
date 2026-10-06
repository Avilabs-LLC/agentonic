import { afterEach, beforeEach, expect, it } from "vitest"
import {
  collection,
  createRagFixture,
  id,
  w,
} from "../scripts/rag-benchmark/fixture"

// The provider ledger feeds usage events (migration 46): each settled operation
// becomes one immutable event attributed to what it paid for; an unsettled
// reservation is an unknown outcome, never zero.
let f: Awaited<ReturnType<typeof createRagFixture>>
beforeEach(async () => {
  f = await createRagFixture()
  await f.sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=1000000 WHERE provider='voyage'"
  )
  await f.actor()
})
afterEach(async () => {
  await f.db.close()
})

type Job = { id: string; token: string; kind: string }
async function spend(job: Job, operation: string, settle?: number) {
  await f.worker(job, "reserve", {
    id: operation,
    provider: "voyage",
    model: "voyage-4",
    microusd: 900,
  })
  if (settle !== undefined)
    await f.worker(job, "settle", {
      id: operation,
      tokens: 120,
      microusd: settle,
    })
}
async function event(operation: string) {
  return (
    await f.sql(
      "SELECT source,source_id,run_id,ingestion_job_id,agent_id,provider,model_identifier,provider_cost_usd::text cost,measurement_status,cost_basis,meter,pricing_evidence FROM agentonic.usage_events WHERE id=$1",
      [operation]
    )
  ).rows[0]
}

it("attributes a document's processing to its ingestion job, once", async () => {
  const object = await f.upload()
  const job = (await f.claim()) as Job
  expect(job.kind).toBe("ingest")
  await spend(job, id(700), 600)
  const ingestion = (
    await f.sql(
      "SELECT id FROM agentonic.ingestion_jobs WHERE background_job_id=$1",
      [job.id]
    )
  ).rows[0] as { id: string }
  expect(await event(id(700))).toEqual({
    source: "ingestion",
    source_id: job.id,
    run_id: null,
    ingestion_job_id: ingestion.id,
    agent_id: null,
    provider: "voyage",
    model_identifier: "voyage-4",
    cost: "0.00060000",
    measurement_status: "measured",
    cost_basis: "estimated",
    meter: "operation",
    pricing_evidence: { inputTokens: 120, outputTokens: 0 },
  })
  expect(object).toBeTruthy()
  // A reservation alone is not an event.
  await spend(job, id(701))
  expect(await event(id(701))).toBeUndefined()
})

it("attributes a search, and counts an unsettled reservation as unknown, never zero", async () => {
  await f.actor()
  await f.rag("search", { query: "garantía", collectionIds: [collection] })
  const job = (await f.claim()) as Job
  expect(job.kind).toBe("retrieve")
  await spend(job, id(710), 300)
  await spend(job, id(711))
  expect(await event(id(710))).toMatchObject({
    source: "search",
    source_id: job.id,
    cost: "0.00030000",
  })
  const summary = async () =>
    (
      await f.sql(
        "SELECT agent_id,reporting_timezone,known_cost_usd::text known,unknown_cost_operations unknown,estimated_cost_operations estimated FROM agentonic.daily_cost_summaries WHERE workspace_id=$1",
        [w]
      )
    ).rows
  // The open reservation is not yet an unknown outcome.
  expect(await summary()).toEqual([
    {
      agent_id: null,
      reporting_timezone: "UTC",
      known: "0.00030000",
      unknown: 0,
      estimated: 1,
    },
  ])
  // An hour later it is unknown, and its reservation is not counted as spend.
  await f.sql(
    "UPDATE agentonic.retrieval_provider_operations SET created_at=clock_timestamp()-interval '61 minutes' WHERE id=$1",
    [id(711)]
  )
  expect(await summary()).toEqual([
    {
      agent_id: null,
      reporting_timezone: "UTC",
      known: "0.00030000",
      unknown: 1,
      estimated: 1,
    },
  ])
})

it("reports each day in the workspace's own time zone", async () => {
  await f.sql(
    "UPDATE agentonic.workspaces SET timezone='Pacific/Kiritimati' WHERE id=$1",
    [w]
  )
  await f.actor()
  await f.rag("search", { query: "garantía", collectionIds: [collection] })
  const job = (await f.claim()) as Job
  await spend(job, id(720))
  // Noon in UTC on 1 January is already 2 January at UTC+14.
  await f.sql(
    "UPDATE agentonic.retrieval_provider_operations SET created_at='2026-01-01 12:00:00+00' WHERE id=$1",
    [id(720)]
  )
  expect(
    (
      await f.sql(
        "SELECT local_date::text AS day,reporting_timezone AS zone,unknown_cost_operations AS unknown FROM agentonic.daily_cost_summaries WHERE workspace_id=$1",
        [w]
      )
    ).rows
  ).toEqual([{ day: "2026-01-02", zone: "Pacific/Kiritimati", unknown: 1 }])
})

it("never changes or forgets spend", async () => {
  await f.actor()
  await f.rag("search", { query: "garantía", collectionIds: [collection] })
  const job = (await f.claim()) as Job
  await spend(job, id(730), 100)
  for (const statement of [
    "UPDATE agentonic.usage_events SET provider_cost_usd=0 WHERE id=$1",
    "DELETE FROM agentonic.usage_events WHERE id=$1",
    "DELETE FROM agentonic.retrieval_provider_operations WHERE id=$1",
  ]) {
    await f.db.exec("SAVEPOINT change_spend")
    await expect(f.sql(statement, [id(730)])).rejects.toThrow()
    await f.db.exec("ROLLBACK TO SAVEPOINT change_spend")
  }
})
