import {
  modelReply,
  toolReply,
  type BrokerReply,
} from "@agentonic/contracts/runtime-protocol"
import { RuntimeError } from "../agent/envelope"
import { runAgentTurn } from "../agent/turn"
// One turn per child process. The parent broker owns the lease, credentials,
// provider and tool execution. IPC is private to that broker/child pair; there
// is no listener, network client or ambient identity in this process.
if (!process.send) throw new Error("Trusted worker IPC required")
const send = (message: unknown, done?: () => void) =>
  process.send!(message, undefined, {}, done)
const pending = new Map<number, (reply: BrokerReply) => void>()
let next = 0
const request = <T extends BrokerReply>(message: Record<string, unknown>) =>
  new Promise<T>((resolve) => {
    const id = ++next
    pending.set(id, resolve as (reply: BrokerReply) => void)
    send({ ...message, id })
  })
let started = false
process.on("message", (message: { type?: string; id?: unknown }) => {
  if (message?.type === "start" && !started) {
    started = true
    runAgentTurn(message, {
      model: (r) => request({ type: "model", ...r }),
      tool: (r) => request({ type: "tool", ...r }),
    }).then(
      (result) => send({ type: "result", result }),
      (error) =>
        send(
          {
            type: "error",
            code: error instanceof RuntimeError ? error.code : "runtime_failed",
          },
          () => process.disconnect()
        )
    )
    return
  }
  const reply =
    message?.type === "model"
      ? modelReply.safeParse(message)
      : toolReply.safeParse(message)
  const resolve = reply.success ? pending.get(reply.data.id) : undefined
  if (!reply.success || !resolve) {
    send({ type: "error", code: "runtime_failed" }, () => process.disconnect())
    return
  }
  pending.delete(reply.data.id)
  resolve(reply.data)
})
process.on("disconnect", () => process.exit())
setTimeout(() => process.exit(1), 115000).unref()
