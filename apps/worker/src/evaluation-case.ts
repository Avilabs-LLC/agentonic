// One graded evaluation case (review protocol 2). A platform tool case carries
// synthetic fixtures (architecture §51): it runs with the frozen version's Gmail,
// Drive or web tools answered from those fixtures, and the grader sees every tool call.
// Other cases run without tools, as before.
import { z } from "zod"
import {
  evaluationFixtures,
  type FixtureCall,
} from "@agentonic/contracts/evaluation-fixtures"
import { toolGrants } from "@agentonic/contracts/tools"
import { fixtureProviders } from "./evaluation-fixtures"
import {
  processJob,
  type Configuration,
  type Execute,
  type Lease,
} from "./pipeline"

export type Grade = (
  input: Record<string, unknown>,
  job: Lease,
  execute: Execute,
  signal: AbortSignal
) => Promise<unknown>

export async function runReviewCase(
  job: Lease,
  execute: Execute,
  config: Configuration,
  grade: Grade,
  signal: AbortSignal
) {
  const raw = (await execute("fixtures", job)).fixtures
  const fixtures = raw ? evaluationFixtures.parse(raw) : undefined
  const calls: FixtureCall[] = []
  let answer: Record<string, unknown> | undefined
  let tools: unknown[] = []
  const capture: Execute = async (operation, lease, payload) => {
    if (operation === "answer") {
      answer = payload
      return { ok: true }
    }
    // The frozen version's own grants, answered from fixtures: nothing live is consulted.
    if (fixtures && (operation === "gmail-tools" || operation === "drive-tools"))
      return { tools }
    if (fixtures && operation === "web-tools")
      return { enabled: !!fixtures.web }
    const result = await execute(operation, lease, payload)
    if (operation === "context" && typeof result.accessJson === "string")
      tools = toolGrants.parse(
        z
          .object({ tools: z.array(z.unknown()).default([]) })
          .parse(JSON.parse(result.accessJson)).tools
      )
    return result
  }
  await processJob(
    job,
    capture,
    fixtures
      ? {
          ...config,
          allowTools: true,
          providers: fixtureProviders(config.providers, fixtures, calls),
        }
      : config,
    signal
  )
  if (!answer) throw new Error("provider_unavailable")
  const context = await execute("grade-context", job)
  const assessment = await grade(
    {
      context,
      answer,
      ...(fixtures ? { fixtures, toolCalls: calls } : {}),
    },
    job,
    execute,
    signal
  )
  await execute("answer", job, { ...answer, assessment })
}
