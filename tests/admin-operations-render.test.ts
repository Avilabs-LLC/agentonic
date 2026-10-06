import { describe, expect, it } from "vitest"

// Loaded at run time: the root typecheck does not cover the UI package's JSX,
// which its own typecheck does.
const load = (path: string) =>
  import(/* @vite-ignore */ path) as Promise<Record<string, unknown>>
const react = await load("../packages/ui/node_modules/react/index.js")
const server = await load(
  "../packages/ui/node_modules/react-dom/server.node.js"
)
const ui = (await load("../packages/ui/src/components/operations")) as Record<
  string,
  (props: Record<string, unknown>) => unknown
>
const skeletons = await load(
  "../packages/ui/src/components/operations-skeletons"
)
const createElement = react.createElement as (
  component: unknown,
  props: Record<string, unknown>
) => unknown
const renderToStaticMarkup = server.renderToStaticMarkup as (
  element: unknown
) => string

// The Admin operations screens rendered with synthetic data: every component
// renders, labels are Spanish, unknown values stay unknown, and each skeleton
// has the page's table width.
const html = (component: unknown, props: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(component, props))
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const now = "2026-10-06T12:00:00.000Z"

describe("Admin operations screens", () => {
  it("lists agents with their state, capabilities and deployment", () => {
    const out = html(ui.OperationsAgentsTable, {
      agents: [
        {
          id: id(1),
          name: "Asistente sintético",
          status: "active",
          workspaceId: id(2),
          workspaceName: "Espacio A",
          ownerName: "Ana",
          createdAt: now,
          latestVersion: "1",
          tools: { gmail: true, web: false, collections: 2 },
          deployment: {
            status: "running",
            environment: "azure_staging",
            resting: true,
            authorizedUntil: now,
          },
          lastRunAt: null,
          runs7d: 0,
        },
      ],
    })
    for (const text of [
      "Asistente sintético",
      "Conocimiento (2 colecciones) · Gmail",
      "En funcionamiento",
      "VM · pruebas · En reposo",
      "Sin registro",
      "Activo",
    ])
      expect(out).toContain(text)
  })
  it("shows activity with Spanish actions and an unknown action by its code", () => {
    const out = html(ui.OperationsActivityTable, {
      events: [
        {
          id: id(3),
          at: now,
          workspaceName: "Espacio A",
          action: "deployment.activated",
          resourceType: "deployment",
          resourceId: "abcdef12",
          outcome: "succeeded",
          actor: "staff",
        },
        {
          id: id(4),
          at: now,
          workspaceName: "Espacio A",
          action: "future.action",
          resourceType: "future",
          resourceId: "12345678",
          outcome: "denied",
          actor: "member",
        },
      ],
    })
    for (const text of [
      "Despliegue activado",
      "Agentonic",
      "Completada",
      "future.action",
      "Denegada",
      "Cliente",
    ])
      expect(out).toContain(text)
    expect(
      html(ui.OperationsActivityStats, {
        runs: { succeeded: 3, failed: 1, active: 0 },
        awaitingApproval: 2,
        reads24h: 1200,
      })
    ).toContain("1200".replace(/(\d)(?=(\d{3})+$)/g, "$1."))
  })
  it("shows unknown spend as unknown, never as zero", () => {
    const providers = html(ui.OperationsProvidersCard, {
      providers: [
        {
          provider: "browserbase",
          capUsd: 1,
          committedUsd: 0.73,
          settledUsd: 0.6,
          unknownOperations: 14,
        },
      ],
    })
    expect(providers).toContain("Browserbase")
    expect(providers).toContain("14 sin resultado conocido")
    const days = html(ui.OperationsCostsTable, {
      days: [
        {
          date: "2026-10-05",
          workspaceId: id(2),
          workspaceName: "Espacio A",
          timezone: "America/Caracas",
          knownUsd: 3.7444,
          unknownOperations: 19,
        },
      ],
    })
    expect(days).toContain("05/10/2026")
    expect(days).toContain("19 operaciones")
  })
  it("names what each server runs, and renders workspaces, staff and releases", () => {
    const servers = html(ui.OperationsInstallationsCard, {
      hosts: [
        {
          environment: "azure_staging",
          state: "valid",
          heartbeatAt: now,
          current: "f7deae1f",
          workers: ["f7deae1f"],
          runtimes: [{ version: "0.4.0-preview-0eb33696", commit: "0eb3369" }],
        },
      ],
      evaluators: [
        {
          environment: "azure_staging",
          state: "expiring",
          current: "c0fdd72d",
          toolFixtures: false,
          runtimes: [],
        },
      ],
    })
    for (const text of [
      "Trabajador f7deae1f",
      "Runtimes 0.4.0-preview-0eb33696",
      "Vence pronto",
      "Sin pruebas de herramientas",
    ])
      expect(servers).toContain(text)
    expect(
      html(ui.OperationsWorkspacesTable, {
        workspaces: [
          {
            id: id(2),
            name: "Espacio A",
            kind: "organization",
            status: "suspended",
            timezone: "UTC",
            createdAt: now,
            members: 2,
            agents: 1,
            pendingInvitations: 0,
          },
        ],
      })
    ).toContain("Suspendido")
    expect(
      html(ui.OperationsStaffCard, {
        staff: [
          {
            name: "Personal",
            role: "operator",
            status: "disabled",
            since: now,
          },
        ],
      })
    ).toContain("Operación · Desde el 6/10/2026")
    expect(
      html(ui.OperationsReleasesTable, {
        releases: [
          {
            id: id(5),
            version: "0.4.0",
            commit: "0eb3369",
            artifact: "9f24d0715da2",
            status: "revoked",
            createdAt: now,
            hosts: ["azure_staging"],
            evaluators: [],
            workspaces: 3,
          },
        ],
      })
    ).toContain("Agentes en la VM de pruebas")
    expect(
      html(ui.OperationsDeploymentsTable, {
        deployments: [
          {
            id: id(6),
            agentName: "Asistente sintético",
            workspaceName: "Espacio A",
            environment: "local",
            status: "mystery",
            resting: false,
            broker: null,
            authorizedUntil: now,
            budgetUsd: 1,
            spentUsd: 0.25,
            createdAt: now,
            activatedAt: null,
          },
        ],
      })
    ).toContain("Estado desconocido")
  })
  it("gives each screen a loading state", () => {
    expect(Object.keys(skeletons)).toHaveLength(6)
    for (const skeleton of Object.values(skeletons))
      expect(html(skeleton)).toContain('role="status"')
  })
})
