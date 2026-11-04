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
import { PreviewFailure } from "./failure"
import {
  processJob,
  type Configuration,
  type Execute,
  type Lease,
} from "./pipeline"

/** Why a model's final answer could not be read, as the person sees it (§75). */
const unreadable: Record<PreviewFailure["diagnostic"], string> = {
  answer_json_invalid: "La respuesta del modelo no era JSON válido.",
  answer_schema_invalid: "La respuesta del modelo no tenía la forma esperada.",
  answer_citations_invalid:
    "La respuesta del modelo citaba fuentes que no se le dieron.",
  response_incomplete: "La respuesta del modelo quedó incompleta.",
}

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
  let model: unknown
  const capture: Execute = async (operation, lease, payload) => {
    if (operation === "answer") {
      answer = payload
      return { ok: true }
    }
    // The frozen version's own grants, answered from fixtures: nothing live is consulted.
    if (
      fixtures &&
      (operation === "gmail-tools" || operation === "drive-tools")
    )
      return {
        tools: toolGrants.parse(tools).map((grant) => {
          // Fixture providers have no credentials. Give their synthetic accounts
          // concrete IDs for the same tool protocol used by the running broker.
          if ("connectionId" in grant && grant.connectionId === null)
            return { ...grant, connectionId: job.id }
          if ("driveConnectionId" in grant && grant.driveConnectionId === null)
            return { ...grant, driveConnectionId: job.id }
          return grant
        }),
      }
    // The version's web grant is checked before this is asked (§72).
    if (fixtures && operation === "web-tools") return { enabled: true }
    const result = await execute(operation, lease, payload)
    if (operation === "context") model = result.previewModel
    if (operation === "context" && typeof result.accessJson === "string")
      tools = toolGrants.parse(
        z
          .object({ tools: z.array(z.unknown()).default([]) })
          .parse(JSON.parse(result.accessJson)).tools
      )
    return result
  }
  try {
    await processJob(
      job,
      capture,
      fixtures
        ? {
            ...config,
            allowTools: true,
            providers: fixtureProviders(config.providers, fixtures, calls),
          }
        : { ...config, allowTools: false },
      signal
    )
  } catch (error) {
    if (!(error instanceof PreviewFailure)) throw error
    // The model's own malformed answer fails its case, not the whole run
    // (§75): nothing is graded, and the next case still runs.
    await execute("answer", job, {
      text: "[Sin respuesta válida: la plataforma no pudo leer la respuesta del modelo.]",
      citations: [],
      insufficientEvidence: true,
      model,
      assessment: {
        verdict: "needs_changes",
        explanation: `${unreadable[error.diagnostic]} Este caso cuenta como no superado; la evaluación siguió con los demás.`,
        suggestion:
          "Si se repite con este modelo, evalúa con otro o simplifica la situación.",
        grounded: false,
        meetsExpectation: false,
        safe: true,
        routine: true,
        confidence: "high",
      },
    })
    return
  }
  if (!answer) throw new Error("provider_unavailable")
  const context = await execute("grade-context", job)
  const assessment = await grade(
    {
      context: {
        ...context,
        // requestedAccess describes the version. The grader also needs the
        // actual execution scope of this case, especially when tools are off.
        caseToolAccess: {
          availableTools: fixtures ? tools : [],
          liveGoogleAccounts: false,
          description: fixtures
            ? "Herramientas de la versión con datos sintéticos. Las propuestas de escritura quedan pendientes de confirmación."
            : "En esta conversación no se ofreció ninguna herramienta de Gmail, Drive ni web, aunque la versión las tenga configuradas.",
        },
      },
      answer,
      ...(fixtures ? { fixtures, toolCalls: calls } : {}),
    },
    job,
    execute,
    signal
  )
  await execute("answer", job, { ...answer, assessment })
}
