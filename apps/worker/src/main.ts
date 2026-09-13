import { workerConfiguration } from "@agentonic/contracts/worker"
const configuration = workerConfiguration.parse({
  name: "agentonic-platform-worker",
  enabled: false,
})
process.stdout.write(
  JSON.stringify({ name: configuration.name, status: "idle", consumers: 0 }) +
    "\n"
)
const heartbeat = setInterval(() => {
  /* Supervised shell; no queue authority or provider calls. */
}, 30_000)
function shutdown() {
  clearInterval(heartbeat)
  process.exitCode = 0
}
process.once("SIGTERM", shutdown)
process.once("SIGINT", shutdown)
