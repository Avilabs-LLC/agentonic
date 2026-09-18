import { beforeEach, afterEach, expect, it } from "vitest"
import {
  createRagFixture,
  id,
  w,
  otherW,
  other,
  staff,
  member,
  collection,
  embedding,
} from "../scripts/rag-benchmark/fixture"
let fixture: Awaited<ReturnType<typeof createRagFixture>>
let db: typeof fixture.db,
  actor: typeof fixture.actor,
  command: typeof fixture.command,
  sql: typeof fixture.sql,
  submit: typeof fixture.submit,
  worker: typeof fixture.worker,
  claim: typeof fixture.claim,
  rag: typeof fixture.rag,
  upload: typeof fixture.upload,
  publish: typeof fixture.publish
beforeEach(async () => {
  fixture = await createRagFixture()
  ;({ db, actor, command, sql, submit, worker, claim, rag, upload, publish } =
    fixture)
})
afterEach(async () => {
  await db.close()
})
it("indexes uploaded documents atomically and retrieves cited authorized text", async () => {
  const object = await upload()
  const job = await claim()
  expect(job.kind).toBe("ingest")
  await publish(job)
  await actor()
  const q = await rag("search", {
    query: "garantía",
    collectionIds: [collection],
  })
  const search = await claim()
  expect(search.id).toBe(q.id)
  await worker(search, "search", { embedding })
  await actor()
  const result = await rag("result", { id: q.id })
  expect(result.status).toBe("succeeded")
  expect(result.matches[0]!.text).toContain("tres años")
  const view = await command("list")
  expect(JSON.stringify(view)).toContain('"chunkCount":1')
  expect((await command("document.download", { objectId: object })).ok).toBe(
    true
  )
})
it("deletion blocks retrieval immediately and hard purge removes all document rows", async () => {
  const object = await upload()
  await publish(await claim())
  await actor()
  await submit()
  expect((await command("document.remove", { objectId: object })).ok).toBe(true)
  expect(
    (await sql("SELECT * FROM agentonic.document_chunks")).rows
  ).toHaveLength(0)
  await actor()
  expect((await command("document.download", { objectId: object })).ok).toBe(
    false
  )
  const purge = await claim()
  expect(purge.kind).toBe("purge")
  await worker(purge, "purged")
  for (const table of [
    "stored_objects",
    "documents",
    "document_versions",
    "document_chunks",
    "knowledge_sources",
    "ingestion_jobs",
    "background_jobs",
  ])
    expect((await sql(`SELECT * FROM agentonic.${table}`)).rows).toHaveLength(0)
  expect(
    (await sql("SELECT * FROM agentonic.agent_submissions")).rows
  ).toHaveLength(1)
})
it("a deleted document cannot be republished by an already running worker", async () => {
  const object = await upload()
  const stale = await claim()
  await actor()
  await command("document.remove", { objectId: object })
  await expect(publish(stale)).rejects.toThrow()
})
it("worker lease replacement fences stale results", async () => {
  await upload()
  const stale = await claim()
  await sql(
    "UPDATE agentonic.background_jobs SET lease_until=now()-interval '1 minute' WHERE id=$1",
    [stale.id]
  )
  const current = await claim()
  expect(current.token).not.toBe(stale.token)
  await expect(publish(stale)).rejects.toThrow()
})
it("other workspaces and staff cannot retrieve customer knowledge", async () => {
  await upload()
  await publish(await claim())
  await actor(other, otherW)
  await expect(
    rag("search", { query: "warranty", collectionIds: [collection] })
  ).rejects.toThrow()
})
it("enforces a global budget before calls and keeps ambiguous requests reserved", async () => {
  await upload()
  const job = await claim()
  const operation = id(900)
  expect(
    (
      await worker(job, "reserve", {
        id: operation,
        provider: "voyage",
        model: "voyage-4",
        microusd: 100,
      })
    ).ok
  ).toBe(false)
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=150 WHERE provider='voyage'"
  )
  expect(
    (
      await worker(job, "reserve", {
        id: operation,
        provider: "voyage",
        model: "voyage-4",
        microusd: 100,
      })
    ).ok
  ).toBe(true)
  expect(
    (
      await worker(job, "reserve", {
        id: id(901),
        provider: "voyage",
        model: "voyage-4",
        microusd: 100,
      })
    ).ok
  ).toBe(false)
  await worker(job, "settle", { id: operation, tokens: 100, microusd: 6 })
  expect(
    (
      await sql(
        "SELECT committed_microusd FROM agentonic.retrieval_provider_budgets WHERE provider='voyage'"
      )
    ).rows[0]
  ).toEqual({ committed_microusd: 6 })
})
it("ordinary app roles cannot claim jobs or call legacy authoring bypass", async () => {
  await expect(db.query("SELECT agentonic.rag_claim(false)")).rejects.toThrow()
})
it("rechecks evidence before answer publication and erases completed answers on deletion", async () => {
  const object = await upload()
  await publish(await claim())
  await actor()
  const q = await rag("search", {
    query: "garantía",
    collectionIds: [collection],
    generateAnswer: true,
  })
  const job = await claim()
  await worker(job, "search", { embedding })
  const context = (await worker(job, "context")) as {
    passages: { id: string }[]
  }
  expect(context.passages).toHaveLength(1)
  await worker(job, "answer", {
    text: "La garantía dura tres años.",
    citations: [context.passages[0]!.id],
    insufficientEvidence: false,
    model: "gpt-4.1-mini-2025-04-14",
  })
  await actor()
  expect(JSON.stringify(await rag("result", { id: q.id }))).toContain(
    "La garantía dura tres años."
  )
  await command("document.remove", { objectId: object })
  expect(JSON.stringify(await rag("result", { id: q.id }))).not.toContain(
    "La garantía dura tres años."
  )
  const rows = await sql(
    "SELECT result,payload FROM agentonic.background_jobs WHERE id=$1",
    [q.id]
  )
  expect(rows.rows[0]).toEqual({ result: {}, payload: {} })
})
it("blocks a generated answer whose document was deleted while the model was running", async () => {
  const object = await upload()
  await publish(await claim())
  await actor()
  await rag("search", {
    query: "garantía",
    collectionIds: [collection],
    generateAnswer: true,
  })
  const job = await claim()
  await worker(job, "search", { embedding })
  const context = (await worker(job, "context")) as {
    passages: { id: string }[]
  }
  await actor()
  await command("document.remove", { objectId: object })
  await expect(
    worker(job, "answer", {
      text: "Three years",
      citations: [context.passages[0]!.id],
      insufficientEvidence: false,
      model: "gpt-4.1-mini-2025-04-14",
    })
  ).rejects.toThrow()
})
it("rejects invented citations even from an authorized worker", async () => {
  await upload()
  await publish(await claim())
  await actor()
  await rag("search", {
    query: "garantía",
    collectionIds: [collection],
    generateAnswer: true,
  })
  const job = await claim()
  await worker(job, "search", { embedding })
  await expect(
    worker(job, "answer", {
      text: "Three years",
      citations: [id(999)],
      insufficientEvidence: false,
      model: "gpt-4.1-mini-2025-04-14",
    })
  ).rejects.toThrow()
})
it("revoking collection access invalidates queued retrieval", async () => {
  await upload()
  await publish(await claim())
  await actor()
  const q = await rag("search", {
    query: "garantía",
    collectionIds: [collection],
  })
  await sql(
    "UPDATE agentonic.workspace_members SET status='suspended' WHERE id=$1",
    [member]
  )
  expect(await claim()).toBeNull()
  expect(
    (
      await sql("SELECT status FROM agentonic.background_jobs WHERE id=$1", [
        q.id,
      ])
    ).rows[0]
  ).toEqual({ status: "cancelled" })
})
it("private ingestion internals are unavailable to customer direct reads and legacy bypass", async () => {
  await expect(
    db.query("SELECT agentonic.authoring_command_v6($1,$2::jsonb,$3::uuid)", [
      "list",
      "{}",
      id(999),
    ])
  ).rejects.toThrow()
})
it("staff cannot use customer retrieval merely by selecting a workspace", async () => {
  await actor(staff, w, "agentonic_admin")
  await expect(
    rag("search", { query: "garantía", collectionIds: [collection] })
  ).rejects.toThrow()
})

it("ranks only the selected collection even when another document matches the query", async () => {
  await upload()
  await publish(await claim(), "The selected warranty lasts three years.")
  const second = id(31)
  await sql(
    "INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,owner_member_id) VALUES($1,$2,'Other knowledge','other-knowledge',$3)",
    [second, w, member]
  )
  await upload(second)
  await publish(await claim(), "The other warranty lasts ninety years.")
  await actor()
  const q = await rag("search", {
    query: "warranty",
    collectionIds: [collection],
  })
  await worker(await claim(), "search", { embedding })
  await actor()
  const result = await rag("result", { id: q.id })
  expect(result.matches).toHaveLength(1)
  expect(result.matches[0]!.text).toContain("three years")
  expect(JSON.stringify(result)).not.toContain("ninety")
})

it("removes empty collections without typing a name and retains only a tombstone", async () => {
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(true)
  expect(JSON.stringify(await command("list"))).not.toContain(collection)
  expect(
    (
      await command("upload.reserve", {
        collectionId: collection,
        title: "fixture.md",
        sha256: "a".repeat(64),
        size: 120,
        contentType: "text/markdown",
      })
    ).ok
  ).toBe(false)
  const tombstone = (
    await sql(
      "SELECT name,slug,description,archived_at FROM agentonic.knowledge_collections WHERE id=$1",
      [collection]
    )
  ).rows[0]!
  expect(tombstone).toMatchObject({
    name: "Colección eliminada",
    description: null,
    archived_at: expect.any(Date),
  })
  expect(
    (await sql("SELECT * FROM agentonic.background_jobs")).rows
  ).toHaveLength(0)
})

it("requires the current name server-side for pending or completed documents, including stale empty views", async () => {
  const pending = await command("upload.reserve", {
    collectionId: collection,
    title: "fixture.md",
    sha256: "a".repeat(64),
    size: 120,
    contentType: "text/markdown",
  })
  expect(pending.ok).toBe(true)
  for (const confirmationName of ["", "knowledge", "Knowledge "]) {
    expect(
      await command("collection.remove", {
        collectionId: collection,
        confirmationName,
      })
    ).toEqual({ ok: false, code: "confirmation_required" })
  }
  expect(
    (
      await sql(
        "SELECT * FROM agentonic.stored_objects WHERE deleted_at IS NULL"
      )
    ).rows
  ).toHaveLength(1)
  await actor()
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "Knowledge",
      })
    ).ok
  ).toBe(true)
  const purge = await claim()
  expect(purge.kind).toBe("purge")
  await worker(purge, "purged")
  expect(
    (await sql("SELECT * FROM agentonic.stored_objects")).rows
  ).toHaveLength(0)
})

it("deletes every collection document, cancels stale ingestion, preserves other collections and usage", async () => {
  const first = await upload()
  await publish(await claim())
  await actor()
  const query = await rag("search", {
    query: "garantía",
    collectionIds: [collection],
  })
  await worker(await claim(), "search", { embedding })
  const second = await upload()
  const stale = await claim()
  await sql(
    "INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,owner_member_id) VALUES($1,$2,'Other knowledge','other-knowledge',$3)",
    [id(31), w, member]
  )
  const retained = await upload(id(31))
  await publish(await claim())
  await sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=10000000,committed_microusd=123 WHERE provider='voyage'"
  )
  await actor()
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "Knowledge",
      })
    ).ok
  ).toBe(true)
  const view = JSON.stringify(await command("list"))
  expect(view).not.toContain(first)
  expect(view).not.toContain(second)
  expect(view).toContain(retained)
  expect(view).toContain('"pendingDeletions":2')
  expect((await rag("result", { id: query.id })).status).not.toBe("succeeded")
  expect((await command("document.download", { objectId: first })).ok).toBe(
    false
  )
  await db.exec("SAVEPOINT stale_publish")
  await expect(publish(stale)).rejects.toThrow()
  await db.exec(
    "ROLLBACK TO SAVEPOINT stale_publish; RELEASE SAVEPOINT stale_publish"
  )
  for (let i = 0; i < 2; i++) {
    const purge = await claim()
    expect(purge.kind).toBe("purge")
    await worker(purge, "purged")
  }
  expect((await sql("SELECT id FROM agentonic.stored_objects")).rows).toEqual([
    { id: retained },
  ])
  expect(
    (await sql("SELECT * FROM agentonic.document_chunks")).rows
  ).toHaveLength(1)
  expect(
    (
      await sql(
        "SELECT committed_microusd::int amount FROM agentonic.retrieval_provider_budgets WHERE provider='voyage'"
      )
    ).rows
  ).toEqual([{ amount: 123 }])
})

it("denies cross-workspace, read-only, revoked and staff collection deletion, but allows a current curator", async () => {
  await actor(other, otherW)
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(false)
  await sql(
    "INSERT INTO agentonic.workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
    [id(103), w, other]
  )
  await sql(
    "INSERT INTO agentonic.collection_member_grants(workspace_id,collection_id,member_id,permission,granted_by_member_id) VALUES($1,$2,$3,'read',$4)",
    [w, collection, id(103), member]
  )
  await actor(other, w)
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(false)
  await sql(
    "UPDATE agentonic.collection_member_grants SET permission='curate',revoked_at=now() WHERE collection_id=$1",
    [collection]
  )
  await actor(other, w)
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(false)
  await actor(staff, w, "agentonic_admin")
  await expect(
    command("collection.remove", {
      collectionId: collection,
      confirmationName: "",
    })
  ).rejects.toThrow()
  await sql(
    "UPDATE agentonic.collection_member_grants SET revoked_at=NULL WHERE collection_id=$1",
    [collection]
  )
  await actor(other, w)
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(true)
})

it("deduplicates collection purge jobs for documents already removed individually", async () => {
  const object = await upload()
  await command("document.remove", { objectId: object })
  expect(
    (
      await command("collection.remove", {
        collectionId: collection,
        confirmationName: "",
      })
    ).ok
  ).toBe(true)
  expect(
    (await sql("SELECT * FROM agentonic.background_jobs WHERE kind='purge'"))
      .rows
  ).toHaveLength(1)
  const purge = await claim()
  await worker(purge, "purged")
  expect(
    (await sql("SELECT * FROM agentonic.stored_objects")).rows
  ).toHaveLength(0)
})
