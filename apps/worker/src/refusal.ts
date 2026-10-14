import type { Execute, Lease } from "./pipeline"

/**
 * OpenAI refused the request outright (4xx: no credit, a rate limit, an invalid
 * request): it generated nothing and bills nothing, so the reservation is
 * released at zero (§78). A server error or a dropped connection may still
 * have been billed, so its reservation stays.
 */
export async function releaseRefused(
  response: Response,
  id: string,
  job: Lease,
  execute: Execute
) {
  if (response.status < 400 || response.status >= 500) return
  // If the release itself fails, the reservation simply stays, as before.
  await execute("settle", job, {
    id,
    microusd: 0,
    tokens: 0,
    outputTokens: 0,
  }).catch(() => {})
}
