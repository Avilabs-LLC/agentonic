import { describe, expect, it } from "vitest"
import {
  Controller,
  REST_AFTER_MS,
  REST_UNUSED_MS,
  metadata,
  restDue,
  type ControllerSystem,
  type Deployment,
  type PassReport,
} from "../apps/worker/src/staging-controller"

const broker = "a".repeat(64)
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

/** A host with many activated agents, counting everything a pass does to it. */
function host(count: number) {
  const work = {
    host: [] as string[],
    running: 0,
    start: 0,
    switch: 0,
  }
  const processes = new Set<string>()
  const system: ControllerSystem = {
    brokerHash: broker,
    host: async (operation) => {
      work.host.push(operation)
      return { ok: true }
    },
    brokerConfig: () => ({ AGENTONIC_BROKER_SHA256: broker }),
    install: () => {
      throw new Error("not used")
    },
    switchCurrent: () => {
      work.switch++
    },
    removeAssets: () => {},
    configure: () => {},
    running: (_broker, id) => {
      work.running++
      return processes.has(id)
    },
    startable: () => true,
    start: (_broker, id) => {
      work.start++
      processes.add(id)
    },
    remove: () => {},
    secret: () => "1".repeat(64),
    now: () => 0,
  }
  const deployments: Deployment[] = Array.from({ length: count }, (_, i) =>
    metadata.parse({
      id: uuid(i),
      workspaceId: uuid(100_000 + i),
      agentId: uuid(200_000 + i),
      environment: "azure_staging",
      status: "running",
      desired: "running",
      heartbeatAt: null,
      broker,
      resting: true,
      pending: false,
    })
  )
  const onDisk = new Map(deployments.map((d) => [d.id, new Set([broker])]))
  const failures: string[] = []
  const report: PassReport = {
    due: () => true,
    ok: () => {},
    fail: (_d, failure) => {
      failures.push(`${failure.step}:${failure.reason}`)
    },
  }
  const controller = new Controller(system)
  const pass = (list = deployments) =>
    controller.pass(
      list,
      [{ sha256: broker, live: true }],
      new Map([...onDisk].map(([id, set]) => [id, new Set(set)])),
      report
    )
  return { work, deployments, pass, failures, processes }
}

describe("resting agents", () => {
  it("leaves 250 idle agents without processes or per-agent work", async () => {
    const h = host(250)
    await h.pass()
    // The release pointer is set once per deployment, then never again.
    expect(h.work).toEqual({ host: [], running: 0, start: 0, switch: 250 })
    await h.pass()
    await h.pass()
    expect(h.work).toEqual({ host: [], running: 0, start: 0, switch: 250 })
    expect(h.processes.size).toBe(0)
    expect(h.failures).toEqual([])
  })
  it("wakes only the agent a turn waits for", async () => {
    const h = host(250)
    await h.pass()
    const waiting = h.deployments.map((d, i) =>
      i === 7 ? { ...d, pending: true } : d
    )
    await h.pass(waiting)
    expect(h.work.host).toEqual(["wake"])
    expect(h.work.start).toBe(1)
    expect([...h.processes]).toEqual([uuid(7)])
    // Awake now: its copy is checked on each pass; the resting ones still are not.
    const awake = h.deployments.map((d, i) =>
      i === 7 ? { ...d, resting: false } : d
    )
    await h.pass(awake)
    expect(h.work.running).toBe(2)
    expect(h.work.start).toBe(1)
    expect(h.failures).toEqual([])
  })
  it("rests a copy after ten idle minutes, or one if it never had work", () => {
    expect(restDue(REST_UNUSED_MS - 1, false)).toBe(false)
    expect(restDue(REST_UNUSED_MS, false)).toBe(true)
    expect(restDue(REST_UNUSED_MS, true)).toBe(false)
    expect(restDue(REST_AFTER_MS, true)).toBe(true)
  })
})

describe("worker upgrades (N2)", () => {
  // Two running deployments on the old broker; the controller runs the new
  // one. The fake database mirrors deployment_host: a move sets the
  // successor, and it refuses a second move while one is in progress.
  it("moves one deployment at a time; the second waits for the first's successor", async () => {
    const [old, next] = ["0".repeat(64), "1".repeat(64)]
    const db = new Map<string, Deployment>(
      [1, 2].map((n) => [
        uuid(n),
        metadata.parse({
          id: uuid(n),
          workspaceId: uuid(100 + n),
          agentId: uuid(200 + n),
          environment: "azure_staging",
          status: "running",
          desired: "running",
          heartbeatAt: null,
          broker: old,
          resting: false,
          pending: false,
        }),
      ])
    )
    const processes = new Set([`${old}:${uuid(1)}`, `${old}:${uuid(2)}`])
    const configs = new Set(processes)
    const moves: string[] = []
    const system: ControllerSystem = {
      brokerHash: next,
      host: async (operation, id) => {
        if (operation === "move") {
          if ([...db.values()].some((d) => d.successorBroker))
            throw new Error("another move is in progress")
          db.set(id, { ...db.get(id)!, successorBroker: next })
          moves.push(id)
        }
        return { manifestHash: "m".repeat(64) }
      },
      brokerConfig: () => ({ AGENTONIC_BROKER_SHA256: next }),
      install: () => ({
        destination: "/instances/synthetic",
        manifestHash: "m".repeat(64),
      }),
      switchCurrent: () => {},
      removeAssets: () => {},
      configure: (broker, id) => {
        configs.add(`${broker}:${id}`)
      },
      running: (broker, id) => processes.has(`${broker}:${id}`),
      startable: () => true,
      start: (broker, id) => {
        processes.add(`${broker}:${id}`)
      },
      remove: (broker, id) => {
        processes.delete(`${broker}:${id}`)
        configs.delete(`${broker}:${id}`)
      },
      secret: () => "1".repeat(64),
      now: () => 0,
    }
    const failures: string[] = []
    const controller = new Controller(system)
    const pass = () => {
      const onDisk = new Map<string, Set<string>>()
      for (const name of configs) {
        const [broker, id] = name.split(":") as [string, string]
        onDisk.set(id, (onDisk.get(id) ?? new Set()).add(broker))
      }
      return controller.pass(
        [...db.values()],
        [
          { sha256: old, live: true },
          { sha256: next, live: true },
        ],
        onDisk,
        {
          due: () => true,
          ok: () => {},
          fail: (_d, f) => {
            failures.push(`${f.step}:${f.reason}`)
          },
        }
      )
    }
    // The successor reports ready: it serves, and the old copy drains.
    const ready = (id: string) =>
      db.set(id, {
        ...db.get(id)!,
        broker: next,
        successorBroker: null,
        drainingBroker: old,
        drainingSince: new Date(0).toISOString(),
      })

    await pass()
    expect(moves).toEqual([uuid(1)])
    // While the first move waits for its successor, the second never starts.
    await pass()
    await pass()
    expect(moves).toEqual([uuid(1)])
    expect(processes.has(`${next}:${uuid(2)}`)).toBe(false)
    ready(uuid(1))
    await pass()
    expect(moves).toEqual([uuid(1), uuid(2)])
    ready(uuid(2))
    await pass()
    expect(failures).toEqual([])
    // Both serve on the new broker; old copies drain and exit by themselves.
    expect(processes.has(`${next}:${uuid(1)}`)).toBe(true)
    expect(processes.has(`${next}:${uuid(2)}`)).toBe(true)
  })
})
