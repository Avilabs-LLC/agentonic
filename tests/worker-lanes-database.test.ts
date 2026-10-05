import { afterEach, beforeEach, expect, it } from "vitest"
import {
  collection,
  createRagFixture,
  id,
  other,
  otherW,
  w,
} from "../scripts/rag-benchmark/fixture"

// The knowledge worker's lanes (migration 43): a claim names the lanes with a
// free slot. Within a lane the workspace with the fewest jobs running goes
// first, then the oldest job, and a workspace holds at most its share.
let f: Awaited<ReturnType<typeof createRagFixture>>
const otherCollection = id(31),
  otherMember = id(102)
beforeEach(async () => {
  f = await createRagFixture()
  await f.sql(
    "INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,owner_member_id) VALUES($1,$2,'Knowledge','knowledge',$3)",
    [otherCollection, otherW, otherMember]
  )
})
afterEach(async () => {
  await f.db.close()
})

type Job = { id: string; token: string; kind: string; lane?: string }
async function claim(lanes: string[]) {
  await f.db.exec("RESET ROLE; SET LOCAL ROLE agentonic_worker")
  const r = await f.db.query<{ result: Job | null }>(
    "SELECT agentonic.knowledge_claim($1::text[]) result",
    [`{${lanes.join(",")}}`]
  )
  return r.rows[0]!.result
}
/** An uploaded document in workspace A or B, its ingestion queued `age` seconds ago. */
async function upload(workspace: string, age: number) {
  let object: string
  if (workspace === w) object = await f.upload()
  else {
    await f.actor(other, otherW)
    const r = await f.command("upload.reserve", {
      collectionId: otherCollection,
      title: "fixture.md",
      sha256: "a".repeat(64),
      size: 120,
      contentType: "text/markdown",
    })
    expect(r.ok).toBe(true)
    await f.sql(
      'INSERT INTO storage.objects(bucket_id,name,metadata) VALUES(\'agentonic-documents\',$1,\'{"size":120,"mimetype":"text/markdown"}\')',
      [`${otherW}/${r.id}`]
    )
    await f.actor(other, otherW)
    expect((await f.command("upload.complete", { objectId: r.id })).ok).toBe(
      true
    )
    object = r.id
  }
  await f.sql(
    "UPDATE agentonic.background_jobs SET created_at=clock_timestamp()-make_interval(secs=>$2) WHERE object_id=$1 AND kind='ingest'",
    [object, age]
  )
  return object
}
async function objectOf(job: Job | null) {
  const r = await f.sql<{ object_id: string }>(
    "SELECT object_id FROM agentonic.background_jobs WHERE id=$1",
    [job?.id]
  )
  return r.rows[0]?.object_id
}
async function refused(query: string, role = "agentonic_worker") {
  await f.db.exec(`RESET ROLE; SAVEPOINT refused; SET LOCAL ROLE ${role}`)
  try {
    await f.db.query(query)
    return null
  } catch (error) {
    return (error as { code?: string }).code
  } finally {
    await f.db.exec("ROLLBACK TO SAVEPOINT refused; RELEASE SAVEPOINT refused")
  }
}

it("serves the workspace with fewer jobs running first, and holds each to its share", async () => {
  const a1 = await upload(w, 30)
  const a2 = await upload(w, 20)
  const b1 = await upload(otherW, 10)
  const first = await claim(["ingest"])
  expect(first).toMatchObject({ kind: "ingest", lane: "ingest" })
  expect(await objectOf(first)).toBe(a1)
  // A is processing a document, so B's newer one goes before A's older second one.
  expect(await objectOf(await claim(["ingest"]))).toBe(b1)
  // Each workspace now holds its one ingestion; A's second document waits.
  expect(await claim(["ingest"])).toBeNull()
  await f.worker(first!, "fail", { code: "invalid_document" })
  expect(await objectOf(await claim(["ingest"]))).toBe(a2)
})

it("claims only from the lanes asked for, cleanup first", async () => {
  const object = await upload(w, 30)
  await f.actor()
  const search = await f.rag("search", {
    query: "garantía",
    collectionIds: [collection],
  })
  expect(await claim(["purge"])).toBeNull()
  // A plain search is not a preview turn.
  expect(await claim(["preview"])).toBeNull()
  const retrieve = await claim(["retrieve", "preview"])
  expect(retrieve).toMatchObject({ id: search.id, lane: "retrieve" })
  // Removing the document queues its cleanup, which goes before its older ingestion.
  await f.actor()
  expect((await f.command("document.remove", { objectId: object })).ok).toBe(
    true
  )
  await upload(w, 40)
  expect(await claim(["ingest", "purge"])).toMatchObject({
    kind: "purge",
    lane: "purge",
  })
})

it("gives preview turns their own lane and a share of two per workspace", async () => {
  const r = await f.sql<Record<string, unknown>>(
    "SELECT agentonic.job_lane('retrieve',$1) preview,agentonic.job_lane('retrieve',NULL) retrieve,agentonic.job_lane('ingest',NULL) ingest,agentonic.job_lane('purge',NULL) purge,agentonic.lane_workspace_limit('preview') preview_share,agentonic.lane_workspace_limit('ingest') ingest_share,agentonic.lane_workspace_limit('retrieve') retrieve_share,agentonic.lane_workspace_limit('purge') purge_share",
    [id(500)]
  )
  expect(r.rows[0]).toEqual({
    preview: "preview",
    retrieve: "retrieve",
    ingest: "ingest",
    purge: "purge",
    preview_share: 2,
    ingest_share: 1,
    retrieve_share: 1,
    purge_share: 1,
  })
})

it("drops work its requester can no longer authorize and claims the next job", async () => {
  const erased = await upload(w, 30)
  const next = await upload(otherW, 10)
  await f.sql(
    "UPDATE agentonic.stored_objects SET deleted_at=clock_timestamp() WHERE id=$1",
    [erased]
  )
  expect(await objectOf(await claim(["ingest"]))).toBe(next)
  const r = await f.sql<{ status: string }>(
    "SELECT status FROM agentonic.background_jobs WHERE object_id=$1 AND kind='ingest'",
    [erased]
  )
  expect(r.rows[0]?.status).toBe("cancelled")
})

it("is the worker's alone and accepts only known lanes", async () => {
  expect(
    await refused(
      "SELECT agentonic.knowledge_claim('{ingest}')",
      "agentonic_customer"
    )
  ).toBe("42501")
  for (const lanes of ["{}", "{ingest,cleanup}", "{ingest,NULL}"])
    expect(
      await refused(`SELECT agentonic.knowledge_claim('${lanes}')`)
    ).toBe("22023")
  expect(await refused("SELECT agentonic.knowledge_claim(NULL)")).toBe("22023")
})

it("keeps the previous claim for the benchmarks: oldest first, no shares", async () => {
  const a1 = await upload(w, 30)
  const a2 = await upload(w, 20)
  await upload(otherW, 10)
  expect(await objectOf(await f.claim())).toBe(a1)
  expect(await objectOf(await f.claim())).toBe(a2)
})
