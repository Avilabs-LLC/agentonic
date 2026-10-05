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
