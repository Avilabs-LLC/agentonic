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
const expiryOverview = (await load(
  "../packages/ui/src/components/expiry-overview"
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

// A badge stands alone in its cell: no text stacked above or below it.
function badgesStandAlone(out: string) {
  for (const [, cell] of out.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g))
    if (cell!.includes('data-slot="badge"'))
      expect(cell).not.toMatch(/<(p|dl|div)[\s>]/)
}

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
      resources: {
        promptCharacters: 12345,
        skillsCount: 2,
        collectionsCount: 2,
        toolsCount: 1,
        connectionsCount: 0,
      },
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
          resources: null,
          summary: { archived: false, live: [], ended: null, next: null },
        },
      ],
    })
    for (const text of [
      `href="/agents/${id(1)}"`,
      "Asistente sintético",
      // The customer list's Recursos, from the saved draft, in fixed slots.
      ">Recursos<",
      'aria-label="Instrucciones listas: 12345 caracteres"',
      'aria-label="Herramientas: 1 · Próximamente"',
      "min-w-[5ch]",
      "Sin borrador",
      "Versión en uso",
      "Próxima versión",
      ">En uso<",
      ">Entorno<",
      ">Despliegue<",
      ">Próxima<",
      ">Propuesta<",
      "En funcionamiento",
      ">vm-agents-01<",
      ">En reposo<",
      ">Sí<",
      "No aplica",
      "En revisión",
      "Ninguna",
      "Sin despliegue",
      "Borrador",
      "Sin registro",
      ">Espacio<",
      'title="Espacio de trabajo"',
      ">Turnos 7 d<",
    ])
      expect(out).toContain(text)
    badgesStandAlone(out)
    // The stored agent status is no longer shown.
    expect(out).not.toContain(">Estado<")
    // The name is the only link to the agent page; no separate ID column.
    expect(out).not.toContain(">ID<")
    expect(out.split(`href="/agents/${id(1)}"`)).toHaveLength(2)
    // One fact per column: no labelled stacks, resting in its own column, and
    // capabilities no longer repeat the version.
    expect(out).not.toContain("<dl")
    expect(out).not.toContain("· En reposo")
    expect(out).not.toContain("Versión 2")
    expect(out).not.toContain("Capacidades")
  })
  it("shows one agent's versions, proposals, deployments and activity", () => {
    const out = html(agentPage.OperationsAgentOverview, {
      now,
      agent: {
        id: id(1),
        name: "Asistente sintético",
        workspaceId: id(2),
        workspaceName: "Espacio A",
        ownerName: "Ana",
        createdAt: now,
        latestVersion: 2,
        tools: { gmail: false, drive: true, web: true, collections: 2 },
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
      // Capabilities as named marks; knowledge in the tile's detail.
      '<span class="sr-only">Google Drive</span>',
      '<span class="sr-only">Acceso web</span>',
      "Versión 2 · 2 colecciones",
      "Propuestas",
      ">Revisión<",
      "Ver comprobante de la revisión",
      "Aprobada",
      "Vigente",
      "Plazo para activar",
      `/submissions/${id(8)}/receipt?workspace=${id(2)}`,
      `/submissions?workspace=${id(2)}`,
      "Abrir en Revisiones",
    ])
      expect(out).toContain(text)
    expect(out).not.toContain('<span class="sr-only">Gmail</span>')
    badgesStandAlone(out)
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
      ">Recurso<",
    ])
      expect(out).toContain(text)
    badgesStandAlone(out)
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
    expect(days).toContain(">5/10/2026<")
    expect(days).toContain(">America/Caracas<")
    expect(days).toContain("19 operaciones")
  })
  it("names what each server runs, and renders workspaces and releases", () => {
    const servers = html(ui.OperationsInstallationsCard, {
      hosts: [
        {
          environment: "azure_staging",
          state: "valid",
          heartbeatAt: now,
          current: "f7deae1f",
          workers: ["f7deae1f"],
          runtimes: [
            { version: "0.4.0-preview-0eb33696", commit: "0eb3369" },
            { version: "0.10.0-preview-649676c5", commit: "649676c" },
            { version: "0.6.0-preview-4b9f84b0", commit: "4b9f84b" },
          ],
        },
        {
          environment: "local",
          state: "valid",
          heartbeatAt: null,
          current: "76c3155d",
          workers: ["76c3155d", "ec30c590"],
          runtimes: [{ version: "0.6.0-preview-4b9f84b0", commit: null }],
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
    // One row per kind, named once, with a column per place.
    for (const [text, times] of [
      [">Agentes</h3>", 1],
      [">Evaluaciones</h3>", 1],
      ["lucide-bot", 1],
      ["lucide-flask-conical", 1],
      [">vm-agents-01<", 3],
      [">Local (desarrollo)<", 3],
    ] as const)
      expect(servers.split(text).length - 1, text).toBe(times)
    for (const text of [
      ">Trabajador f7deae1f<",
      ">En servicio: 76c3155d, ec30c590<",
      // The newest runtime by number, not as text; the rest collapsed.
      ">Runtime 0.10.0</span>",
      'title="0.10.0-preview-649676c5"',
      "y 2 más",
      ">Runtime 0.6.0</span>",
      ">Sin reportes<",
      ">Evaluador c0fdd72d<",
      ">Sin runtimes<",
      ">Sin pruebas de herramientas<",
      ">Sin registrar<",
      "Vence pronto",
    ])
      expect(servers).toContain(text)
    expect(servers).not.toContain("·")
    // Vencimientos: the deadline and the verification on their own lines.
    const registrations = html(expiryOverview.RegistrationsCard, {
      now,
      registrations: {
        hosts: [
          {
            environment: "azure_staging",
            state: "valid",
            expiresAt: "2026-11-01T00:00:00.000Z",
            verifiedAt: "2026-10-02T00:00:00.000Z",
          },
          {
            environment: "local",
            state: "retired",
            expiresAt: "2026-10-01T00:00:00.000Z",
            verifiedAt: "2026-09-01T00:00:00.000Z",
          },
        ],
        evaluators: [
          {
            environment: "azure_staging",
            state: "expired",
            expiresAt: "2026-10-05T00:00:00.000Z",
            verifiedAt: "2026-09-05T00:00:00.000Z",
          },
        ],
      },
    })
    for (const text of [
      ">Vence el 1/11/2026, 12:00 a. m. UTC<",
      ">Verificada el 2/10/2026, 12:00 a. m. UTC<",
      ">Venció el 5/10/2026, 12:00 a. m. UTC<",
      ">Verificada el 1/9/2026, 12:00 a. m. UTC<",
    ])
      expect(registrations).toContain(text)
    expect(registrations).not.toContain("Vence el 1/10/2026")
    expect(registrations).not.toContain("·")
    const workspaces = html(ui.OperationsWorkspacesTable, {
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
    for (const text of ["Suspendido", ">Organización<", ">UTC<"])
      expect(workspaces).toContain(text)
    badgesStandAlone(workspaces)
    const releases = html(ui.OperationsReleasesTable, {
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
    for (const text of ["1 instalación", ">0eb3369<", ">9f24d0715da2<"])
      expect(releases).toContain(text)
    const deployments = html(ui.OperationsDeploymentsTable, {
      deployments: [
        {
          id: id(6),
          agentId: id(1),
          agentName: "Asistente sintético",
          workspaceName: "Espacio A",
          environment: "local",
          status: "mystery",
          resting: false,
          versionNumber: 3,
          broker: null,
          authorizedUntil: now,
          budgetUsd: 1,
          spentUsd: 0.25,
          createdAt: now,
          activatedAt: null,
        },
      ],
    })
    expect(deployments).toMatch(/Estado desconocido[\s\S]*No aplica/)
    for (const text of [
      "Sin trabajador",
      "Sin activar",
      ">Entorno<",
      ">Versión<",
      'data-slot="badge"',
    ])
      expect(deployments).toContain(text)
    badgesStandAlone(deployments)
  })
  it("gives each screen a loading state", () => {
    expect(Object.keys(skeletons)).toHaveLength(8)
    for (const skeleton of Object.values(skeletons))
      expect(html(skeleton)).toContain('role="status"')
  })
})
