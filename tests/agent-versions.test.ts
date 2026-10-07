import { expect, it } from "vitest"
import type { AgentVersionSummary } from "../packages/contracts/src/agent-versions"
import { agentVersionsView } from "../packages/ui/src/lib/agent-versions"

// One badge per agent (architecture §55): on the version in use when one
// runs, otherwise on the next version or Borrador.
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const summary = (
  fields: Partial<AgentVersionSummary> = {}
): AgentVersionSummary => ({
  archived: false,
  live: [],
  ended: null,
  next: null,
  ...fields,
})
const running = (status = "running") => ({
  environment: "azure_staging" as const,
  status,
  resting: false,
  versionNumber: 1,
  submissionId: id(1),
})
const proposal = (
  fields: Partial<NonNullable<AgentVersionSummary["next"]>>
) => ({
  submissionId: id(2),
  number: 2,
  versionNumber: 2,
  status: "submitted",
  approvalReason: null,
  approvalExpiresAt: null,
  deployment: null,
  ...fields,
})

it("gives each facet its state and its facts as separate fields", () => {
  const v = agentVersionsView(
    summary({ live: [running()], next: proposal({ status: "in_review" }) })
  )
  expect(v.live.state?.label).toBe("En funcionamiento")
  expect(v.live.versionNumber).toBe(1)
  expect(v.live.place).toBe("vm-agents-01")
  expect(v.next.state?.label).toBe("En revisión")
  expect(v.next.versionNumber).toBe(2)
  expect(v.next.place).toBeNull()
  expect(v.next.detail).toBe("Versión 2")
})

it("keeps resting out of the detail; it applies only while running", () => {
  const resting = { ...running(), resting: true }
  const v = agentVersionsView(summary({ live: [resting] }))
  expect(v.resting).toBe(true)
  expect(v.live.detail).toBe("Versión 1 · vm-agents-01")
  expect(agentVersionsView(summary({ live: [running()] })).resting).toBe(false)
  expect(
    agentVersionsView(summary({ live: [{ ...resting, status: "offline" }] }))
      .resting
  ).toBeNull()
  expect(agentVersionsView(summary({})).resting).toBeNull()
})

it("reports an offline or unauthorized version in use truthfully", () => {
  expect(
    agentVersionsView(summary({ live: [running("offline")] })).live.state?.label
  ).toBe("Sin conexión")
  expect(
    agentVersionsView(summary({ live: [running("unauthorized")] })).live.state
      ?.label
  ).toBe("Autorización no vigente")
  expect(agentVersionsView(summary({ live: [running()] })).next.detail).toBe(
    "Sin propuestas nuevas"
  )
})

it("shows a stopped version in use and an approved next version", () => {
  const pending = agentVersionsView(
    summary({
      ended: {
        environment: "azure_staging",
        status: "stopped",
        versionNumber: 1,
      },
      next: proposal({
        status: "approved",
        approvalReason: "valid",
        deployment: {
          environment: "azure_staging",
          status: "awaiting_activation",
        },
      }),
    })
  )
  expect(pending.live.state?.label).toBe("Detenido")
  expect(pending.next.state?.label).toBe("Pendiente de activación")
  const lapsed = agentVersionsView(
    summary({
      next: proposal({ status: "approved", approvalReason: "expired" }),
    })
  )
  expect(lapsed.next.state?.label).toBe("Vencida")
  expect(lapsed.next.detail).toBe("Versión 2")
})

it("calls an agent with nothing proposed a draft, and marks archived agents", () => {
  const draft = agentVersionsView(summary())
  expect(draft.live.detail).toBe("Ninguna")
  expect(draft.next.state?.label).toBe("Borrador")
  const archived = agentVersionsView(summary({ archived: true }))
  expect(archived.live.state?.label).toBe("Archivado")
})

it("sorts versions in use before ended ones and pending activation first", () => {
  const ranks = [
    summary({ live: [running()] }),
    summary({
      ended: { environment: "local", status: "failed", versionNumber: 1 },
    }),
    summary(),
  ].map((s) => agentVersionsView(s).live.rank)
  expect([...ranks].sort((a, b) => a - b)).toEqual(ranks)
  const next = [
    proposal({
      deployment: { environment: "local", status: "awaiting_activation" },
    }),
    proposal({ status: "approved", approvalReason: "valid" }),
    proposal({ status: "in_review" }),
    proposal({ status: "rejected" }),
  ].map((n) => agentVersionsView(summary({ next: n })).next.rank)
  expect([...next].sort((a, b) => a - b)).toEqual(next)
})
