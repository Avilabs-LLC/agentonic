import { afterEach, beforeEach, expect, it } from "vitest"
import { createRagFixture, owner, w } from "../scripts/rag-benchmark/fixture"

// The knowledge worker's Storage account (migration 42): it sees a document
// object only while an ingestion or purge job for it holds a live lease, and
// deletes one only during its purge. Customer rules stay as they were.
let f: Awaited<ReturnType<typeof createRagFixture>>
beforeEach(async () => {
  f = await createRagFixture()
})
afterEach(async () => {
  await f.db.close()
})

const workerAccount = {
  sub: "20000000-0000-4000-8000-000000000001",
  role: "authenticated",
  app_metadata: { agentonic_service: "storage_worker" },
}
async function as(claims: Record<string, unknown>) {
  await f.db.exec("RESET ROLE;SET LOCAL ROLE authenticated")
  await f.db.query("SELECT set_config('request.jwt.claims',$1,true)", [
    JSON.stringify(claims),
  ])
}
async function visible(claims: Record<string, unknown>, key: string) {
  await as(claims)
  const r = await f.db.query(
    "SELECT name FROM storage.objects WHERE bucket_id='agentonic-documents' AND name=$1",
    [key]
  )
  return r.rows.length
}
async function remove(claims: Record<string, unknown>, key: string) {
  await as(claims)
  const r = await f.db.query(
    "DELETE FROM storage.objects WHERE bucket_id='agentonic-documents' AND name=$1 RETURNING name",
    [key]
  )
  return r.rows.length
}

it("reads a document only while its ingestion holds a live lease", async () => {
  const object = await f.upload()
  const key = `${w}/${object}`
  // Queued, not yet claimed: nothing to read.
  expect(await visible(workerAccount, key)).toBe(0)
  const job = await f.claim()
  expect(job.kind).toBe("ingest")
  expect(await visible(workerAccount, key)).toBe(1)
  // Ingestion never deletes, and the account never writes.
  expect(await remove(workerAccount, key)).toBe(0)
  await as(workerAccount)
  await f.db.exec("SAVEPOINT write_attempt")
  await expect(
    f.db.query(
      "INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('agentonic-documents',$1,'{}')",
      [`${w}/30000000-0000-4000-8000-000000000001`]
    )
  ).rejects.toThrow()
  await f.db.exec("ROLLBACK TO SAVEPOINT write_attempt")
  // Even an erased object cannot be deleted under an ingestion lease; only a purge deletes.
  await f.sql(
    "UPDATE agentonic.stored_objects SET deleted_at=clock_timestamp() WHERE id=$1",
    [object]
  )
  expect(await remove(workerAccount, key)).toBe(0)
  // An expired lease opens nothing.
  await f.sql(
    "UPDATE agentonic.background_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
    [job.id]
  )
  expect(await visible(workerAccount, key)).toBe(0)
})

it("deletes a document only during its purge, and only as the worker's account", async () => {
  const object = await f.upload()
  const key = `${w}/${object}`
  await f.actor()
  expect((await f.command("document.remove", { objectId: object })).ok).toBe(
    true
  )
  // The purge is queued but not claimed yet.
  expect(await remove(workerAccount, key)).toBe(0)
  const purge = await f.claim()
  expect(purge.kind).toBe("purge")
  // A customer, another service name or a forged role cannot delete it.
  expect(await remove({ sub: owner, role: "authenticated" }, key)).toBe(0)
  expect(
    await remove(
      {
        ...workerAccount,
        app_metadata: { agentonic_service: "storage_admin" },
      },
      key
    )
  ).toBe(0)
  expect(
    await remove(
      {
        ...workerAccount,
        user_metadata: { agentonic_service: "storage_worker" },
        app_metadata: {},
      },
      key
    )
  ).toBe(0)
  expect(await remove(workerAccount, key)).toBe(1)
  await f.sql("RESET ROLE")
  expect(
    (
      await f.sql("SELECT count(*)::int n FROM storage.objects WHERE name=$1", [
        key,
      ])
    ).rows[0]
  ).toEqual({ n: 0 })
})

it("keeps customer access to their own documents unchanged", async () => {
  const object = await f.upload()
  const key = `${w}/${object}`
  expect(await visible({ sub: owner, role: "authenticated" }, key)).toBe(1)
  // Customers still cannot delete uploaded documents.
  expect(await remove({ sub: owner, role: "authenticated" }, key)).toBe(0)
})
