import { randomUUID } from "node:crypto"
import { webArguments, type WebOperation } from "@agentonic/contracts/web"
import {
  browserbaseClient,
  searchWeb,
  readWeb,
  verifyPublicWebUrl,
  classifyWebError,
} from "@agentonic/connectors/browserbase"
import type { Execute, Lease } from "./pipeline"

export async function executeWeb(
  operation: WebOperation,
  args: unknown,
  job: Lease,
  execute: Execute,
  key: string,
  signal: AbortSignal,
  timeoutMs = 20000
): Promise<Record<string, unknown>> {
  const parsed = webArguments[operation].parse(args)
  const client = browserbaseClient(key)
  let url: string | undefined
  try {
    url = "url" in parsed ? await verifyPublicWebUrl(parsed.url) : undefined
  } catch (error) {
    await execute("web-check", job)
    return unavailable(classifyWebError(error), job, operation)
  }
  if (signal.aborted) throw new Error("lease_lost")
  const id = randomUUID()
  const payload = { id, operation }
  const reserved = await execute("web-reserve", job, payload)
  if (!reserved.ok) {
    await execute("web-check", job)
    if (
      reserved.code === "rate_limit" ||
      reserved.code === "budget_exhausted" ||
      reserved.code === "call_limit"
    )
      return { ok: false, error: reserved.code, stop: true, untrusted: true }
    throw new Error("lease_lost")
  }
  await execute("web-check", job)
  let result: unknown
  const providerSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(Math.max(1, timeoutMs)),
  ])
  try {
    result =
      "query" in parsed
        ? { results: await searchWeb(client, parsed.query, providerSignal) }
        : await readWeb(client, url!, providerSignal)
  } catch (error) {
    // Do not refund uncertain usage or retry a failed request. Recheck live
    // authority before returning a recoverable tool result to the model.
    if (signal.aborted) throw new Error("lease_lost")
    await execute("web-check", job)
    return unavailable(classifyWebError(error), job, operation)
  }
  await execute("web-settle", job, payload)
  await execute("web-check", job)
  return { ...(result as Record<string, unknown>), ok: true, untrusted: true }
}

function unavailable(
  error: ReturnType<typeof classifyWebError>,
  job: Lease,
  operation: WebOperation
) {
  // Only allowlisted metadata: never log URLs, queries, content or SDK messages.
  console.info(
    JSON.stringify({
      event: "web_tool_unavailable",
      job: job.id,
      operation,
      code: error.code,
      status: error.status,
    })
  )
  return {
    ok: false,
    error: error.code,
    stop: error.code === "rate_limit",
    untrusted: true,
    guidance:
      "This source was not verified. Do not infer its contents or retry this request. Try a different source within the remaining allowance, or explain the limitation.",
  }
}
