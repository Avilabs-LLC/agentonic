import { expect, it } from "vitest"

// Cambiar estado in Revisiones offers only what the database allows for each
// review (migration 67), and says why when nothing applies. Loaded at run time
// like the other UI modules: the root typecheck does not cover their JSX.
const load = (path: string) => import(/* @vite-ignore */ path)
const { reviewStateTargets } = (await load(
  "../packages/ui/src/components/change-review-state-dialog"
)) as {
  reviewStateTargets: (
    review: Record<string, unknown>,
    canRevoke: boolean
  ) => { targets: string[] } | { reason: string }
}
const review = (fields: Record<string, unknown>) => ({
  id: "r",
  workspaceId: "w",
  agentName: "Synthetic agent",
  versionNumber: 2,
  number: 3,
  status: "submitted",
  canOpen: true,
  canDecide: true,
  ...fields,
})

it("offers the decisions an open, evaluated review allows", () => {
  expect(reviewStateTargets(review({}), true)).toEqual({
    targets: ["in_review", "changes_requested", "rejected"],
  })
  expect(reviewStateTargets(review({ status: "in_review" }), false)).toEqual({
    targets: ["changes_requested", "rejected"],
  })
})

it("explains why an open review cannot change yet", () => {
  expect(reviewStateTargets(review({ canOpen: false }), true)).toEqual({
    reason: "Sin autorización vigente del cliente",
  })
  expect(reviewStateTargets(review({ canDecide: false }), true)).toEqual({
    reason:
      "Disponible cuando el cliente confirme los criterios y termine la evaluación",
  })
})

it("revokes an approval only for roles that may, and leaves closed reviews alone", () => {
  expect(reviewStateTargets(review({ status: "approved" }), true)).toEqual({
    targets: ["revoked"],
  })
  expect(reviewStateTargets(review({ status: "approved" }), false)).toEqual({
    reason: "Revocar requiere el rol de Administración u Operación",
  })
  for (const status of [
    "superseded",
    "withdrawn",
    "rejected",
    "changes_requested",
    "revoked",
  ])
    expect(reviewStateTargets(review({ status }), true)).toEqual({
      reason: "Revisión cerrada",
    })
})
