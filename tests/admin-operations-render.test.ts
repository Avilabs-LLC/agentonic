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
const agentPage = (await load(
  "../packages/ui/src/components/operations-agent"
)) as Record<string, (props: Record<string, unknown>) => unknown>
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
  it("lists agents with the version in use, the next version and capabilities", () => {
    const agent = {
      id: id(1),
      name: "Asistente sintético",
      status: "draft",
      workspaceId: id(2),
      workspaceName: "Espacio A",
      ownerName: "Ana",
      createdAt: now,
      latestVersion: "2",
      tools: { gmail: true, web: false, collections: 2 },
      deployment: null,
      lastRunAt: null,
      runs7d: 0,
    }
    const out = html(ui.OperationsAgentsTable, {
      agents: [
        {
          ...agent,
          summary: {
            archived: false,
            live: [
              {
                environment: "azure_staging",
                status: "running",
                resting: true,
                versionNumber: 1,
                submissionId: id(7),
              },
            ],
            ended: null,
            next: {
              submissionId: id(8),
              number: 6,
              versionNumber: 2,
              status: "in_review",
              approvalReason: null,
              approvalExpiresAt: null,
              deployment: null,
            },
          },
        },
        {
          ...agent,
          id: id(9),
          name: "Agente nuevo",
          summary: { archived: false, live: [], ended: null, next: null },
        },
      ],
    })
    for (const text of [
      `href="/agents/${id(1)}"`,
      "Asistente sintético",
      "Conocimiento (2 colecciones) · Gmail",
      "Versión en uso",
      "Próxima versión",
      "En funcionamiento",
      "Versión 1 · vm-agents-01 · En reposo",
      "En revisión",
      "Versión 2",
      "Ninguna",
      "Borrador",
      "Sin enviar a revisión",
      "Sin registro",
    ])
      expect(out).toContain(text)
    // The stored agent status is no longer shown.
    expect(out).not.toContain(">Estado<")
  })
  it("shows one agent's versions, proposals, deployments and activity", () => {
    const out = html(agentPage.OperationsAgentOverview, {
      agent: {
        id: id(1),
        name: "Asistente sintético",
        workspaceId: id(2),
        workspaceName: "Espacio A",
        ownerName: "Ana",
        createdAt: now,
        latestVersion: 2,
        tools: { gmail: false, web: true, collections: 0 },
        summary: {
          archived: false,
          live: [],
          ended: {
            environment: "azure_staging",
            status: "stopped",
            versionNumber: 1,
          },
          next: {
            submissionId: id(8),
            number: 6,
            versionNumber: 2,
            status: "approved",
            approvalReason: "valid",
            approvalExpiresAt: now,
            deployment: {
              environment: "azure_staging",
              status: "awaiting_activation",
            },
          },
        },
        proposals: [
          {
            id: id(8),
            number: 6,
            versionNumber: 2,
            status: "approved",
            submittedAt: now,
            approvalReason: "valid",
            approvalExpiresAt: now,
          },
          {
            id: id(10),
            number: 7,
            versionNumber: 3,
            status: "in_review",
            submittedAt: now,
            approvalReason: null,
            approvalExpiresAt: null,
          },
        ],
        deployments: [
          {
            id: id(11),
            submissionId: id(7),
            environment: "azure_staging",
            status: "stopped",
            resting: false,
            versionNumber: 1,
            authorizedUntil: now,
            budgetUsd: 0.25,
            spentUsd: 0.01,
            createdAt: now,
            activatedAt: null,
          },
        ],
        activity: { lastRunAt: null, runs7d: 0, failed7d: 0, knownUsd30d: 0 },
      },
    })
    for (const text of [
      "Detenido",
      "Pendiente de activación",
      "Versión 2 · vm-agents-01",
      "Versión 1 · vm-agents-01",
      "Web",
      "Propuestas",
      "Versión 2 · Revisión 6",
      "Aprobada",
      "Aprobación vigente",
      "Plazo para activar",
      `/submissions/${id(8)}/receipt?workspace=${id(2)}`,
      `/submissions?workspace=${id(2)}`,
      "Abrir en Revisiones",
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
          agentId: id(1),
          agentName: "Asistente sintético",
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
          agentId: null,
          agentName: null,
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
      `href="/agents/${id(1)}"`,
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
    ).toContain("1 instalación")
    expect(
      html(ui.OperationsDeploymentsTable, {
        deployments: [
          {
            id: id(6),
            agentId: id(1),
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
    ).toMatch(/Estado desconocido[\s\S]*No aplica/)
  })
  it("gives each screen a loading state", () => {
    expect(Object.keys(skeletons)).toHaveLength(7)
    for (const skeleton of Object.values(skeletons))
      expect(html(skeleton)).toContain('role="status"')
  })
})
