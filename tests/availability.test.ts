import { expect, it } from "vitest"
import {
  customerAgentAvailability,
  customerAvailability,
  unavailableOnOurSide,
} from "../packages/contracts/src/availability"
import type { LifecycleState } from "../packages/contracts/src/lifecycle"

const now = new Date("2026-10-05T12:00:00.000Z")
const day = (n: number) =>
  new Date(now.getTime() + n * 24 * 3600_000).toISOString()
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
type Deployment = LifecycleState["deployments"][number]
type Submission = LifecycleState["submissions"][number]
const submission = (fields: Partial<Submission> = {}): Submission => ({
  id: id(1),
  number: 1,
  candidateId: id(2),
  versionNumber: 1,
  approvalId: id(3),
  reason: "valid",
  expiresAt: day(1),
  renewalRequested: false,
  renewedSubmissionId: null,
  canRequestRenewal: false,
  canRenew: false,
  canAuthorize: true,
  ...fields,
})
const deployment = (fields: Partial<Deployment> = {}): Deployment => ({
  id: id(10),
  submissionId: id(1),
  environment: "azure_staging",
  status: "running",
  authorized: true,
  online: true,
  models: [],
  expiresAt: day(4),
  budgetUsd: 0.25,
  committedMicrousd: 0,
  errorCode: null,
  canActivate: false,
  canStop: true,
  canChat: true,
  ...fields,
})
const state = (
  fields: Partial<Pick<LifecycleState, "hosts" | "submissions">> = {}
) => ({
  hosts: [{ environment: "azure_staging" as const, available: true }],
  submissions: [submission()],
  ...fields,
})
const say = (
  d: Partial<Deployment>,
  s: Partial<Pick<LifecycleState, "hosts" | "submissions">> = {}
) => customerAvailability(deployment(d), state(s), now)
// Customers never read infrastructure terms.
const jargon =
  /\bVM\b|servidor|host|despliegue|broker|heartbeat|verificaci|registro|sin conexión/i

it("tells the customer until when a running agent is available and what to do next", () => {
  expect(say({})).toBe(
    "Disponible para tus conversaciones hasta el 9/10/2026, 12:00 p. m. UTC. Para seguir usándolo después, autoriza de nuevo su uso."
  )
  // A running agent outlives its activation deadline; renewing consent then
  // needs a new approval first.
  expect(
    say({}, { submissions: [submission({ reason: "expired" })] })
  ).toContain("renueva la aprobación y autoriza de nuevo su uso")
})

it("says an outage is on Agentonic's side and asks nothing of the customer", () => {
  expect(say({ online: false })).toBe(
    `${unavailableOnOurSide} Su uso sigue autorizado hasta el 9/10/2026, 12:00 p. m. UTC.`
  )
  expect(
    say(
      { authorized: false, online: false },
      { hosts: [{ environment: "azure_staging", available: false }] }
    )
  ).toBe(unavailableOnOurSide)
})

it("asks for a new authorization when consent ended, and never guesses other reasons", () => {
  expect(say({ authorized: false, expiresAt: day(-1) })).toBe(
    "La autorización de uso terminó el 4/10/2026, 12:00 p. m. UTC. Para seguir usándolo, autoriza de nuevo su uso."
  )
  expect(say({ authorized: false })).toBe(
    "Esta autorización ya no es válida. Puedes autorizar de nuevo su uso."
  )
  expect(
    say(
      { authorized: false },
      {
        submissions: [
          submission({ reason: "superseded", canAuthorize: false }),
        ],
      }
    )
  ).toBe("Esta autorización ya no es válida.")
})

it("explains waiting for activation and the approval deadline that bounds it", () => {
  expect(say({ status: "awaiting_activation", online: false })).toBe(
    "El equipo de Agentonic lo activará; no tienes que hacer nada más. Si no se activa antes del 6/10/2026, 12:00 p. m. UTC, tendrás que renovar la aprobación."
  )
  expect(
    say(
      { status: "awaiting_activation", online: false },
      {
        submissions: [
          submission({
            reason: "expired",
            expiresAt: day(-1),
            canAuthorize: false,
          }),
        ],
      }
    )
  ).toBe(
    "La aprobación venció antes de la activación. Para usarlo, renueva la aprobación y autoriza de nuevo su uso."
  )
  expect(say({ status: "preparing", online: false })).toBe(
    "Se está activando. Podrás usarlo en tus conversaciones cuando termine."
  )
})

it("describes ended activations and offers a new authorization only when allowed", () => {
  expect(say({ status: "stopped", online: false })).toBe(
    "Detenido. Sus conversaciones ya no están disponibles. Puedes autorizar de nuevo su uso."
  )
  expect(
    say(
      { status: "failed", online: false },
      { submissions: [submission({ canAuthorize: false })] }
    )
  ).toBe("No se pudo activar.")
})

it("keeps every customer message free of infrastructure terms", () => {
  const cases: [
    Partial<Deployment>,
    Partial<Pick<LifecycleState, "hosts" | "submissions">>,
  ][] = [
    [{}, {}],
    [{ online: false }, {}],
    [{ authorized: false, expiresAt: day(-1) }, {}],
    [{ authorized: false }, { hosts: [] }],
    [{ authorized: false }, {}],
    [{ status: "awaiting_activation" }, {}],
    [{ status: "queued" }, {}],
    [{ status: "stopped" }, {}],
    [{ status: "failed" }, {}],
    [{ status: "superseded" }, {}],
  ]
  for (const [d, s] of cases) expect(say(d, s)).not.toMatch(jargon)
})

it("summarizes the agent for its header", () => {
  expect(customerAgentAvailability({ deployments: [] })).toBe("Sin activar")
  expect(
    customerAgentAvailability({
      deployments: [
        deployment({ expiresAt: day(2) }),
        deployment({ id: id(11), expiresAt: day(5) }),
      ],
    })
  ).toBe("Disponible hasta el 10/10/2026, 12:00 p. m. UTC")
  expect(
    customerAgentAvailability({ deployments: [deployment({ online: false })] })
  ).toBe("No disponible por ahora")
  expect(
    customerAgentAvailability({
      deployments: [
        deployment({ status: "awaiting_activation", online: false }),
      ],
    })
  ).toBe("Activación pendiente")
  expect(
    customerAgentAvailability({
      deployments: [deployment({ status: "stopped", online: false })],
    })
  ).toBe("Sin activar")
})
