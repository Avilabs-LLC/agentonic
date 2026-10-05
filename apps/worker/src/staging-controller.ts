// Deployment controller decisions, separated from systemd, processes and files so
// they can be exercised against the real database functions.
//
// One controller per host runs the host's current broker. Every running
// deployment has a serving copy (a process of the broker release it was started
// on) and, during an upgrade, at most one other copy: a successor starting on
// the current broker, or the replaced copy draining the turn it leased.
import { join } from "node:path"
import { z } from "zod"
import { reasonOf, type Backoff } from "./service-state"
import { digest } from "./staging-files"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
export const metadata = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  agentId: z.uuid(),
  environment: z.enum(["local", "azure_staging"]),
  status: z.string(),
  desired: z.enum(["running", "stopped"]),
  heartbeatAt: z.string().nullable(),
  broker: hash.nullable().default(null),
  successorBroker: hash.nullable().default(null),
  drainingBroker: hash.nullable().default(null),
  drainingSince: z.string().nullable().default(null),
})
export type Deployment = z.infer<typeof metadata>
export const pollResult = z.object({
  deployments: z.array(z.unknown()),
  brokers: z.array(z.object({ sha256: hash, live: z.boolean() })),
})
/** Retry pacing per deployment: a copy that should run is retried until it does. */
export const COPY: Backoff = { first: 10_000, max: 300_000 }
/** A successor not ready by then is abandoned; the serving copy keeps serving. */
export const SUCCESSOR_READY_MS = 120_000
export const MOVE_COOLDOWN_MS = 10 * 60_000
/** Turns end within two minutes, so a draining copy is stopped after that. */
export const DRAIN_MS = 150_000
/** A copy that stops this soon after starting failed; its restarts back off. */
export const QUICK_EXIT_MS = 30_000

export class StepFailure extends Error {
  constructor(
    readonly step: string,
    readonly reason: string
  ) {
    super(reason)
  }
}
export async function step<T>(name: string, run: () => T | Promise<T>) {
  try {
    return await run()
  } catch (error) {
    if (error instanceof StepFailure) throw error
    throw new StepFailure(name, reasonOf(error))
  }
}

/** Everything the controller does to the machine and the database. */
export type ControllerSystem = {
  brokerHash: string
  host(
    operation: string,
    id: string,
    payload?: Record<string, unknown>
  ): Promise<unknown>
  /** The current broker's configuration file, re-read for every new copy. */
  brokerConfig(): Record<string, string>
  /** Materializes (or verifies) the deployment's frozen release directory. */
  install(prepared: unknown): { destination: string; manifestHash: string }
  switchCurrent(d: Deployment): void
  removeAssets(d: Deployment): void
  /** Writes one copy's private configuration; fails if it already exists. */
  configure(broker: string, id: string, settings: Record<string, string>): void
  running(broker: string, id: string): boolean
  start(broker: string, id: string): void
  /** Stops one copy and removes its secret, credentials and unit drop-in. */
  remove(broker: string, id: string): void
  secret(): string
  now(): number
}
export type Poll = { live: Set<string>; moving: boolean }
export const isActive = (d: Deployment) =>
  d.desired === "running" &&
  ["queued", "preparing", "running"].includes(d.status)

/** How a pass reports each deployment; failures never stop the pass. */
export type PassReport = {
  /** Whether a failing deployment's next attempt is due. */
  due(id: string): boolean
  ok(id: string): void
  fail(d: Deployment, failure: StepFailure): void | Promise<void>
}

export class Controller {
  private readonly successors = new Map<string, number>()
  private readonly cooldowns = new Map<string, number>()
  private readonly started = new Map<string, number>()
  constructor(private readonly system: ControllerSystem) {}

  /** One pass over a poll: every deployment's copies, brought toward what the database says. */
  async pass(
    deployments: Deployment[],
    brokers: { sha256: string; live: boolean }[],
    onDisk: Map<string, Set<string>>,
    report: PassReport,
    stopping = () => false
  ) {
    const poll: Poll = {
      live: new Set(brokers.filter((b) => b.live).map((b) => b.sha256)),
      moving: deployments.some((d) => !!d.successorBroker),
    }
    for (const d of deployments) {
      if (stopping()) break
      if (isActive(d) && !report.due(d.id)) continue
      try {
        await this.reconcile(d, onDisk.get(d.id) ?? new Set(), poll)
        report.ok(d.id)
      } catch (error) {
        await report.fail(
          d,
          error instanceof StepFailure
            ? error
            : new StepFailure("reconcile", reasonOf(error))
        )
      }
    }
  }

  /** Starts a new copy of a deployment on the current broker. */
  private async createCopy(
    d: Deployment,
    operation: "prepare" | "move" | "restore"
  ) {
    const system = this.system
    // Check the local configuration first so a copy that cannot start never rotates a token.
    const brokerConfig = system.brokerConfig()
    if (brokerConfig.AGENTONIC_BROKER_SHA256 !== system.brokerHash)
      throw new StepFailure("precheck", "configuration_changed")
    const secret = system.secret()
    const prepared = await step(operation, () =>
      system.host(operation, d.id, { tokenHash: digest(secret) })
    )
    const installed = await step("install", () => system.install(prepared))
    // Customer text never becomes command text, environment entries or an executable.
    await step("configure", () =>
      system.configure(system.brokerHash, d.id, {
        ...brokerConfig,
        AGENTONIC_DEPLOYMENT_ID: d.id,
        AGENTONIC_DEPLOYMENT_SECRET: secret,
        AGENTONIC_MANIFEST_PATH: join(installed.destination, "manifest.json"),
        AGENTONIC_MANIFEST_HASH: installed.manifestHash,
      })
    )
    await step("start", () => system.start(system.brokerHash, d.id))
    this.started.set(`${system.brokerHash}:${d.id}`, system.now())
  }

  /** Starts a copy that should run but does not. One that stopped right after its last start counts as a failure, so the caller's backoff paces the next attempt. */
  private async ensure(broker: string, id: string) {
    const system = this.system
    if (system.running(broker, id)) return
    const key = `${broker}:${id}`
    const last = this.started.get(key)
    this.started.delete(key)
    if (last !== undefined && system.now() - last < QUICK_EXIT_MS)
      throw new StepFailure("start", "copy_exited")
    await step("start", () => system.start(broker, id))
    this.started.set(key, system.now())
  }

  async reconcile(d: Deployment, onDisk: Set<string>, poll: Poll) {
    const system = this.system
    const remove = (broker: string) => {
      this.started.delete(`${broker}:${d.id}`)
      return step("stop", () => system.remove(broker, d.id))
    }
    if (!isActive(d)) {
      for (const broker of onDisk) await remove(broker)
      // Retain the content-free manifest and usage; remove generated private assets.
      system.removeAssets(d)
      this.successors.delete(d.id)
      this.cooldowns.delete(d.id)
      return
    }
    const serving = d.broker ?? system.brokerHash
    const wanted = new Set(
      [serving, d.successorBroker, d.drainingBroker].filter(
        (broker): broker is string => !!broker
      )
    )
    // Copies the database no longer lists (an abandoned move, an interrupted restore) go first.
    for (const broker of [...onDisk])
      if (!wanted.has(broker)) {
        await remove(broker)
        onDisk.delete(broker)
      }
    if (d.status === "queued") return this.createCopy(d, "prepare")
    if (d.status === "preparing") {
      if (onDisk.has(serving)) await this.ensure(serving, d.id)
      if (d.heartbeatAt && system.now() - Date.parse(d.heartbeatAt) > 90000) {
        await step("fail", () => system.host("fail", d.id))
        for (const broker of onDisk) await remove(broker)
      }
      return
    }
    // The serving copy can no longer run (broker revoked, installation gone):
    // replace it on the current broker at once.
    if (!poll.live.has(serving) || !onDisk.has(serving)) {
      for (const broker of onDisk) await remove(broker)
      this.successors.delete(d.id)
      return this.createCopy(d, "restore")
    }
    await this.ensure(serving, d.id)
    await step("switch", () => system.switchCurrent(d))
    if (d.successorBroker) {
      const successor = d.successorBroker
      const began = this.successors.get(d.id) ?? system.now()
      this.successors.set(d.id, began)
      if (
        !poll.live.has(successor) ||
        !onDisk.has(successor) ||
        system.now() - began > SUCCESSOR_READY_MS
      ) {
        await remove(successor)
        await step("abandon", () => system.host("abandon", d.id))
        this.successors.delete(d.id)
        this.cooldowns.set(d.id, system.now() + MOVE_COOLDOWN_MS)
        throw new StepFailure("move", "successor_not_ready")
      }
      await this.ensure(successor, d.id)
      return
    }
    this.successors.delete(d.id)
    if (d.drainingBroker) {
      const draining = d.drainingBroker
      // A draining copy exits by itself once its leased turn ends.
      if (
        !poll.live.has(draining) ||
        !system.running(draining, d.id) ||
        system.now() - Date.parse(d.drainingSince ?? "") > DRAIN_MS
      ) {
        await remove(draining)
        await step("drained", () => system.host("drained", d.id))
      }
      return
    }
    // Move deployments to the current broker one at a time.
    if (
      serving !== system.brokerHash &&
      !poll.moving &&
      system.now() >= (this.cooldowns.get(d.id) ?? 0)
    ) {
      poll.moving = true
      this.successors.set(d.id, system.now())
      await this.createCopy(d, "move")
    }
  }
}
