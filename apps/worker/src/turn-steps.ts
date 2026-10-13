import {
  MAX_TURN_STEPS,
  stepText,
  type TurnStep,
} from "@agentonic/contracts/turn-steps"
import type { Operation } from "./broker"

type Bag = Record<string, unknown>
const bag = (value: unknown): Bag =>
  typeof value === "object" && value !== null ? (value as Bag) : {}
const list = (value: unknown) => (Array.isArray(value) ? value : undefined)
const header = (message: unknown, name: string) =>
  list(bag(message).headers)
    ?.map(bag)
    .find((h) => String(h.name).toLowerCase() === name)?.value
const host = (url: unknown) => {
  try {
    return new URL(String(url)).hostname || null
  } catch {
    return stepText(url)
  }
}

/** What a call is about before it runs, from its checked arguments. */
function startTarget(op: Operation, args: Bag) {
  switch (op.operation) {
    case "gmail.search":
    case "web.search":
      return stepText(args.query)
    case "gmail.drafts.create":
    case "gmail.send":
      return stepText(args.subject)
    case "gmail.drafts.update":
      return stepText(bag(args.message).subject)
    case "gmail.labels.apply":
      return stepText(
        [...new Set(list(args.labels)?.map((l) => bag(l).label))].join(", ")
      )
    case "web.read":
      return host(args.url)
    case "drive.files.list":
      return stepText(args.name)
    case "drive.docs.create":
      return stepText(args.title)
    default:
      return null
  }
}

/** What a call found, from the result the model gets back. */
function endStep(op: Operation, args: Bag, raw: unknown): Partial<TurnStep> {
  const result = bag(raw)
  if (result.ok === false || typeof result.error === "string")
    return { status: "failed" }
  if (result.pendingApproval === true || result.automatic === true)
    return {
      status: "proposed",
      count:
        op.operation === "gmail.labels.apply"
          ? (list(args.labels)?.length ?? null)
          : null,
    }
  switch (op.operation) {
    case "gmail.search":
      return { status: "done", count: list(result.messages)?.length ?? 0 }
    case "gmail.read":
    case "gmail.drafts.read":
      return { status: "done", target: stepText(header(result, "subject")) }
    case "gmail.threads.read": {
      const messages = list(result.messages) ?? []
      const earlier = Number(result.earlierMessages) || 0
      return {
        status: "done",
        target: stepText(header(messages[0], "subject")),
        count: messages.length + earlier,
      }
    }
    case "gmail.drafts.list":
      return { status: "done", count: list(result.drafts)?.length ?? 0 }
    case "web.search":
      return { status: "done", count: list(result.results)?.length ?? 0 }
    case "drive.files.list":
      return { status: "done", count: list(result.files)?.length ?? 0 }
    case "drive.files.read":
      return { status: "done", target: stepText(result.name) }
    default:
      return { status: "done" }
  }
}

/**
 * The steps of one chat or preview turn (§74). The broker opens a step when a
 * tool call starts and closes it with what came back. Every change sends the
 * whole list, one write at a time, best effort: a write that fails never
 * stops the turn, and the latest list always follows the one being written.
 */
export class StepLog {
  readonly steps: TurnStep[] = []
  private dirty = false
  private writing: Promise<void> | undefined

  constructor(private send: (steps: TurnStep[]) => Promise<unknown>) {}

  /** Opens a step; -1 once the turn already shows its maximum. */
  start(op: Operation, args: unknown) {
    if (this.steps.length >= MAX_TURN_STEPS) return -1
    this.steps.push({
      tool: op.operation,
      target: startTarget(op, bag(args)),
      count: null,
      status: "running",
    })
    this.publish()
    return this.steps.length - 1
  }

  end(index: number, op: Operation, args: unknown, result: unknown) {
    const step = this.steps[index]
    if (!step) return
    const found = endStep(op, bag(args), result)
    this.steps[index] = {
      ...step,
      ...found,
      target: found.target ?? step.target,
    }
    this.publish()
  }

  /** Waits for the latest list to be written, before the answer is recorded. */
  async flush() {
    while (this.writing) await this.writing
  }

  private publish() {
    this.dirty = true
    this.writing ??= this.drain()
  }

  private async drain() {
    while (this.dirty) {
      this.dirty = false
      const steps = this.steps.map((step) => ({ ...step }))
      await Promise.resolve()
        .then(() => this.send(steps))
        .catch(() => {})
    }
    this.writing = undefined
  }
}
