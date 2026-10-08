import { describe, expect, it } from "vitest"

// Loaded at run time: the root typecheck does not cover the UI package's JSX.
const load = (path: string) =>
  import(/* @vite-ignore */ path) as Promise<Record<string, unknown>>
const react = await load("../packages/ui/node_modules/react/index.js")
const server = await load(
  "../packages/ui/node_modules/react-dom/server.node.js"
)
const { AgentSchedules } = (await load(
  "../packages/ui/src/components/agent-schedules"
)) as Record<string, (props: Record<string, unknown>) => unknown>
const html = (props: Record<string, unknown>) =>
  (server.renderToStaticMarkup as (e: unknown) => string)(
    (react.createElement as (c: unknown, p: unknown) => unknown)(
      AgentSchedules,
      props
    )
  )
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const deployment = {
  id: id(5),
  online: true,
  authorizedUntil: "2026-10-15T12:00:00.000Z",
  models: [{ model: "gpt-5.4-mini", reasoning: "medium" }],
  writes: ["gmail.send"],
}
const schedule = {
  id: id(1),
  name: "Resumen diario",
  instruction: "Resume mi correo.",
  cadence: "weekdays",
  timeOfDay: "08:00",
  weekday: null,
  everyHours: null,
  timezone: "America/Caracas",
  model: "gpt-5.4-mini",
  reasoning: "medium",
  autonomy: ["gmail.send"],
  status: "active",
  nextRunAt: "2026-10-09T12:00:00.000Z",
  lastRunAt: null,
  createdAt: "2026-10-08T12:00:00.000Z",
  runs: [
    {
      id: id(2),
      scheduledFor: "2026-10-08T12:00:00.000Z",
      manual: false,
      status: "succeeded",
      reason: null,
      conversationId: id(3),
      actions: [
        { operation: "gmail.send", status: "succeeded", automatic: true },
      ],
      createdAt: "2026-10-08T12:00:00.000Z",
      finishedAt: "2026-10-08T12:01:00.000Z",
    },
  ],
}

// Scheduled jobs (architecture §58): the Programaciones tab.
describe("Programaciones", () => {
  it("explains an empty tab and a missing running version", () => {
    const out = html({
      workspaceId: id(9),
      agentId: id(8),
      initial: { timezone: "America/Caracas", deployment: null, schedules: [] },
    })
    expect(out).toContain("Nueva programación")
    expect(out).toContain("Sin versión en funcionamiento")
    expect(out).toContain("Sin programaciones")
  })
  it("lists a schedule with its cadence, next time in its zone, outcome and automatic actions", () => {
    const out = html({
      workspaceId: id(9),
      agentId: id(8),
      initial: {
        timezone: "America/Caracas",
        deployment,
        schedules: [schedule],
      },
    })
    expect(out).toContain("Resumen diario")
    expect(out).toContain("Días laborables a las 08:00")
    expect(out).toContain("America/Caracas")
    expect(out).toContain("Completada")
    expect(out).toContain("Enviar correo")
    expect(out).toContain("Activa")
    expect(out).not.toContain("Sin versión en funcionamiento")
  })
})
