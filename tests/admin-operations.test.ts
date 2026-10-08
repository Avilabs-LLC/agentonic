import { afterEach, beforeEach, expect, it } from "vitest"
import {
  operationsActivity,
  operationsAgents,
  operationsCosts,
  operationsDeployments,
  operationsReleases,
  operationsWorkspaces,
} from "../packages/contracts/src/operations"
import {
  collection,
  createRagFixture,
  id,
  staff,
  w,
} from "../scripts/rag-benchmark/fixture"

// The Admin operations screens' reads (migration 48): staff only, metadata only.
let f: Awaited<ReturnType<typeof createRagFixture>>
beforeEach(async () => {
  f = await createRagFixture()
})
afterEach(async () => {
  await f.db.close()
})

const reads = {
  operations_agents: operationsAgents,
  operations_activity: operationsActivity,
  operations_workspaces: operationsWorkspaces,
  operations_deployments: operationsDeployments,
  operations_costs: operationsCosts,
  operations_releases: operationsReleases,
} as const
async function read<K extends keyof typeof reads>(
  name: K
): Promise<ReturnType<(typeof reads)[K]["parse"]>> {
  const r = await f.db.query<{ result: unknown }>(
    `SELECT agentonic.${name}() result`
  )
  return reads[name].parse(r.rows[0]!.result) as ReturnType<
    (typeof reads)[K]["parse"]
  >
}
async function refused(name: keyof typeof reads, role: string) {
  await f.db.exec(`SAVEPOINT refused; RESET ROLE; SET LOCAL ROLE ${role}`)
  try {
    await f.db.query(`SELECT agentonic.${name}()`)
    return false
  } catch {
    return true
  } finally {
    await f.db.exec("ROLLBACK TO SAVEPOINT refused; RELEASE SAVEPOINT refused")
  }
}

it("gives staff every operations read, as metadata only", async () => {
  // Content that must never reach the operations screens.
  await f.actor()
  await f.command("draft.save", {
    agentId: id(20),
    revision: 0,
    content: {
      version: 1,
      systemPrompt: "SECRET-PROMPT-TEXT for a synthetic agent.",
      skills: [],
    },
    requestedAccess: { version: 1, collectionIds: [collection], tools: [] },
  })
  await f.upload()
  await f.sql(
    "UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=1000000 WHERE provider='voyage'"
  )
  const job = (await f.claim()) as { id: string; token: string; kind: string }
  await f.worker(job, "reserve", {
    id: id(800),
    provider: "voyage",
    model: "voyage-4",
    microusd: 900,
  })
  await f.worker(job, "settle", { id: id(800), tokens: 10, microusd: 400 })
  await f.publish(job, "DOCUMENT-TEXT that stays private.")

  await f.actor(staff, w, "agentonic_admin")
  const agents = await read("operations_agents")
  expect(agents).toEqual([
    expect.objectContaining({
      id: id(20),
      name: "Synthetic agent",
      workspaceName: "A",
      ownerName: "Owner",
      deployment: null,
      runs7d: 0,
      // Counted from the saved draft, as on the customer agent list.
      resources: expect.objectContaining({ connectionsCount: 0 }),
    }),
  ])
  const workspaces = await read("operations_workspaces")
  expect(
    workspaces.workspaces.map((x) => [x.name, x.members, x.agents])
  ).toEqual([
    ["A", 1, 1],
    ["B", 1, 0],
  ])
  expect(workspaces.staff).toEqual([
    expect.objectContaining({
      name: "Staff",
      role: "administrator",
      status: "active",
    }),
  ])
  const activity = await read("operations_activity")
  expect(activity.events.map((e) => e.action)).toContain("draft.save")
  expect(
    activity.events.every((e) => !["list", "detail"].includes(e.action))
  ).toBe(true)
  expect(activity.events.find((e) => e.action === "draft.save")?.actor).toBe(
    "member"
  )
  const costs = await read("operations_costs")
  expect(costs.providers.find((p) => p.provider === "voyage")).toMatchObject({
    capUsd: 1,
    settledUsd: 0.0004,
  })
  expect(costs.days).toEqual([
    expect.objectContaining({ workspaceName: "A", knownUsd: 0.0004 }),
  ])
  expect((await read("operations_releases"))[0]).toMatchObject({
    version: "0.1.0",
    status: "available",
    workspaces: 1,
  })
  expect(await read("operations_deployments")).toEqual({
    deployments: [],
    hosts: [],
    evaluators: [],
  })
  // No prompt or document text in any of them.
  for (const name of Object.keys(reads) as (keyof typeof reads)[]) {
    const raw = JSON.stringify(
      (await f.db.query(`SELECT agentonic.${name}() result`)).rows[0]
    )
    expect(raw).not.toContain("SECRET-PROMPT-TEXT")
    expect(raw).not.toContain("DOCUMENT-TEXT")
  }
})

it("refuses customers, services and disabled staff", async () => {
  for (const name of Object.keys(reads) as (keyof typeof reads)[]) {
    await f.actor()
    expect(await refused(name, "agentonic_customer")).toBe(true)
    expect(await refused(name, "agentonic_worker")).toBe(true)
  }
  await f.sql(
    "UPDATE agentonic.platform_staff SET disabled_at=clock_timestamp() WHERE id=$1",
    [staff]
  )
  await f.actor(staff, w, "agentonic_admin")
  await f.db.exec("SAVEPOINT disabled")
  await expect(
    f.db.query("SELECT agentonic.operations_agents()")
  ).rejects.toThrow()
  await f.db.exec("ROLLBACK TO SAVEPOINT disabled")
})
