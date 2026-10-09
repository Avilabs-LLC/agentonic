import { expect, it } from "vitest"
import type { ReviewListing } from "../packages/contracts/src/authoring"
import {
  expiryRows,
  type RuntimeRegistrations,
} from "../packages/contracts/src/expiry"

const now = new Date("2026-10-05T12:00:00.000Z")
const day = (n: number) =>
  new Date(now.getTime() + n * 24 * 3600_000).toISOString()
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
let next = 0
function review(
  fields: Partial<ReviewListing[number]> = {}
): ReviewListing[number] {
  next += 1
  return {
    id: id(next),
    workspaceId: id(100),
    workspaceName: "Synthetic workspace",
    agentName: `Synthetic agent ${next}`,
    userId: id(200),
    userName: "Synthetic submitter",
    userEmail: null,
    versionNumber: 1,
    number: 1,
    canOpen: false,
    canDecide: false,
    status: "approved",
    approvalReason: "valid",
    approvalExpiresAt: day(2),
    deploymentStatus: "none",
    ...fields,
  }
}
const deployed = (
  status: string,
  fields: Partial<ReviewListing[number]> = {}
) =>
  review({
    deploymentStatus: status,
    deploymentEnvironment: "azure_staging",
    deploymentAuthorized: true,
    consentExpiresAt: day(4),
    ...fields,
  })
const registrations = (
  host: Partial<RuntimeRegistrations["hosts"][number]> = {}
): RuntimeRegistrations => ({
  hosts: [
    {
      environment: "azure_staging",
      verifiedAt: day(-1),
      expiresAt: day(6),
      state: "valid",
      ...host,
    },
  ],
  evaluators: [],
})
const only = (
  reviews: ReviewListing,
  hosts: RuntimeRegistrations = registrations()
) => {
  const rows = expiryRows(reviews, hosts, now)
  expect(rows).toHaveLength(1)
  return rows[0]!
}

it("lists only approved versions with a valid approval or a pending or running deployment", () => {
  const rows = expiryRows(
    [
      review({ status: "submitted", approvalReason: "unapproved" }),
      review({ approvalReason: "expired", approvalExpiresAt: day(-1) }),
      review({ approvalReason: "expired", deploymentStatus: "stopped" }),
      review({ status: "revoked", approvalReason: "superseded" }),
      review(),
      deployed("running", { approvalReason: "expired" }),
    ],
    registrations(),
    now
  )
  expect(rows.map((row) => row.status)).toEqual(["none", "running"])
})

it("asks the customer to authorize a valid approval before its activation deadline", () => {
  const row = only([review()])
  expect(row).toMatchObject({
    environment: null,
    consentExpiresAt: null,
    host: null,
    next: {
      actor: "customer",
      action: "Autorizar el uso de pruebas",
      by: day(2),
    },
  })
})

it("asks the team to activate before the first of the three deadlines", () => {
  expect(only([deployed("awaiting_activation")]).next).toEqual({
    actor: "staff",
    action: "Activar la versión",
    by: day(2),
  })
  expect(
    only(
      [deployed("awaiting_activation")],
      registrations({ expiresAt: day(1) })
    ).next.by
  ).toBe(day(1))
  expect(
    only([
      deployed("awaiting_activation", {
        approvalReason: "expired",
        approvalExpiresAt: day(-1),
      }),
    ]).next
  ).toEqual({ actor: "customer", action: "Renovar la aprobación", by: null })
})

it("names whichever of consent or server verification lapses first for a running agent", () => {
  const row = only([deployed("running")])
  expect(row).toMatchObject({
    environment: "azure_staging",
    approvalExpiresAt: day(2),
    consentExpiresAt: day(4),
    host: { expiresAt: day(6) },
    next: {
      actor: "customer",
      action: "Autorizar de nuevo para seguir usándolo",
      by: day(4),
    },
  })
  expect(
    only([deployed("running")], registrations({ expiresAt: day(3) })).next
  ).toEqual({
    actor: "staff",
    action: "Renovar la verificación del servidor",
    by: day(3),
  })
  // A running agent outlives its activation deadline, but renewing consent
  // then needs a new approval.
  expect(
    only([
      deployed("running", {
        approvalReason: "expired",
        approvalExpiresAt: day(-1),
      }),
    ]).next
  ).toEqual({
    actor: "customer",
    action: "Renovar la aprobación para seguir usándolo",
    by: day(4),
  })
})

it("puts a lapsed server first and never guesses an unreported reason", () => {
  expect(
    only(
      [deployed("offline", { deploymentAuthorized: false })],
      registrations({ expiresAt: day(-1), state: "expired" })
    )
  ).toMatchObject({
    status: "unauthorized",
    next: {
      actor: "staff",
      action: "Renovar la verificación del servidor",
      by: day(-1),
    },
  })
  expect(
    only([
      deployed("running", {
        deploymentAuthorized: false,
        consentExpiresAt: day(-1),
      }),
    ]).next
  ).toEqual({
    actor: "customer",
    action: "Autorizar de nuevo el uso de pruebas",
    by: day(2),
  })
  expect(
    only([deployed("running", { deploymentAuthorized: false })]).next
  ).toEqual({ actor: "staff", action: "Revisar el comprobante", by: null })
})

it("reports installation in progress and offline agents from observed status", () => {
  expect(only([deployed("preparing")]).next).toEqual({
    actor: null,
    action: "Instalación en curso",
    by: day(2),
  })
  expect(only([deployed("offline")]).next).toEqual({
    actor: "staff",
    action: "Revisar el agente sin conexión",
    by: null,
  })
})

it("orders actions needed now first, then the nearest deadline", () => {
  const rows = expiryRows(
    [
      deployed("queued", { agentName: "Queued" }),
      review({ agentName: "Later", approvalExpiresAt: day(3) }),
      deployed("offline", { agentName: "Offline" }),
      review({ agentName: "Sooner", approvalExpiresAt: day(1) }),
    ],
    registrations(),
    now
  )
  expect(rows.map((row) => row.agentName)).toEqual([
    "Offline",
    "Sooner",
    "Queued",
    "Later",
  ])
})
