import { describe, expect, it, vi } from "vitest"

// Admin's Equipo page (architecture §63), rendered on the server with a
// synthetic team: Spanish labels, unknown roles by their code, and actions and
// emails only for administrators, never on their own row.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }))
const load = (path: string) =>
  import(/* @vite-ignore */ path) as Promise<Record<string, unknown>>
type Component = (props: Record<string, unknown>) => unknown
const react = await load("../packages/ui/node_modules/react/index.js")
const server = await load(
  "../packages/ui/node_modules/react-dom/server.node.js"
)
const { StaffTable, InviteStaffDialog } = (await load(
  "../packages/ui/src/components/staff-team"
)) as Record<string, Component>
const { InvitationsTable } = (await load(
  "../packages/ui/src/components/members-panel"
)) as Record<string, Component>
const { InvitationAcceptance } = (await load(
  "../packages/ui/src/components/account-forms"
)) as Record<string, Component>
const { staffRoleLabels } = await import("../packages/contracts/src/operations")
const html = (component: unknown, props: Record<string, unknown>) =>
  (server.renderToStaticMarkup as (e: unknown) => string)(
    (react.createElement as (c: unknown, p: unknown) => unknown)(
      component,
      props
    )
  )
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const now = "2026-10-09T12:00:00.000Z"
const person = (
  n: number,
  name: string,
  role: string,
  extra: Record<string, unknown> = {}
) => ({
  id: id(n),
  name,
  email: `${name.toLowerCase()}@example.test`,
  role,
  status: "active",
  since: now,
  ...extra,
})
const update = async () => ({ ok: true })
const menus = (out: string) =>
  out.match(/aria-label="Acciones del registro"/g)?.length ?? 0

describe("Equipo", () => {
  it("shows administrators every column, with actions on everyone but themselves", () => {
    const out = html(StaffTable, {
      team: {
        viewer: { staffId: id(1), role: "administrator" },
        staff: [
          person(1, "Ana", "administrator"),
          person(2, "Olga", "operator"),
          person(3, "Sergio", "support", { status: "disabled", email: null }),
          person(4, "Bea", "billing"),
        ],
        invitations: [],
      },
      update,
    })
    for (const text of [
      ">Correo<",
      "olga@example.test",
      "Sin registro",
      ">Administración<",
      ">Operación<",
      ">Soporte<",
      ">billing<",
      "Desactivado",
      "9/10/2026",
    ])
      expect(out).toContain(text)
    expect(menus(out)).toBe(3)
  })

  it("shows other staff the team without emails or actions", () => {
    const out = html(StaffTable, {
      team: {
        viewer: { staffId: id(2), role: "operator" },
        staff: [
          { ...person(1, "Ana", "administrator"), email: null },
          { ...person(2, "Olga", "operator"), email: null },
        ],
        invitations: null,
      },
      update,
    })
    expect(out).not.toContain(">Correo<")
    expect(menus(out)).toBe(0)
    expect(out).toContain("Ana")
  })

  it("lists staff invitations with staff roles, and invites with a role", () => {
    const out = html(InvitationsTable, {
      invitations: [
        {
          id: id(9),
          email: "nuevo@example.test",
          role: "support",
          expiresAt: "2999-01-01T00:00:00.000Z",
          acceptedAt: null,
          revokedAt: null,
        },
      ],
      revoke: update,
      roleLabels: staffRoleLabels,
    })
    expect(out).toContain(">Soporte<")
    expect(out).toContain("Pendiente")
    expect(html(InviteStaffDialog, { invite: update })).toContain(
      "Invitar al equipo"
    )
    const accept = html(InvitationAcceptance, {
      email: "nuevo@example.test",
      accept: update,
    })
    expect(accept).toContain("nuevo@example.test")
  })
})
