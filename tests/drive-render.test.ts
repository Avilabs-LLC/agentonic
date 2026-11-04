import { readFileSync } from "node:fs"
import { describe, expect, it, vi } from "vitest"

// Google Drive in Configuración and Conocimiento (architecture §62), rendered
// on the server with synthetic accounts and files.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh() {}, replace() {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))
const load = (path: string) =>
  import(/* @vite-ignore */ path) as Promise<Record<string, unknown>>
type Component = (props: Record<string, unknown>) => unknown
const react = await load("../packages/ui/node_modules/react/index.js")
const server = await load(
  "../packages/ui/node_modules/react-dom/server.node.js"
)
const { DriveTools, DriveFiles, DriveAccount, pickOnGooglePage } = (await load(
  "../packages/ui/src/components/drive-connection"
)) as Record<string, Component>
const { GmailConnection } = (await load(
  "../packages/ui/src/components/gmail-connection"
)) as Record<string, Component>
const { DriveImport } = (await load(
  "../packages/ui/src/components/drive-import"
)) as Record<string, Component>
const html = (component: unknown, props: Record<string, unknown>) =>
  (server.renderToStaticMarkup as (e: unknown) => string)(
    (react.createElement as (c: unknown, p: unknown) => unknown)(
      component,
      props
    )
  )
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const doc = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345"

describe("Configuración › Google Drive", () => {
  it("shows the account with Drive's logo and its connection state", () => {
    expect(
      html(DriveAccount, {
        account: "drive@example.invalid",
        status: "connected",
      })
    ).toContain("Cuenta conectada")
    expect(
      html(DriveAccount, {
        account: "drive@example.invalid",
        status: "reconnect",
      })
    ).toContain("Necesita volver a conectarse")
    // While the Google app is in Testing, until when Google authorizes it (§84).
    expect(
      html(DriveAccount, {
        account: "drive@example.invalid",
        status: "connected",
        expiresAt: "2099-01-01T12:00:00.000Z",
      })
    ).toContain("Autorización de Google hasta el 1/1/2099")
  })

  it("lists the agent's files with their type and who added them", () => {
    const out = html(DriveFiles, {
      workspaceId: id(1),
      agentId: id(2),
      connectionId: id(3),
      files: [
        {
          fileId: doc,
          name: "Plan de lanzamiento",
          mimeType: "application/vnd.google-apps.document",
          origin: "picked",
          addedAt: "2026-10-09T12:00:00Z",
        },
        {
          fileId: "1CreatedAbCdEfGhIjKl",
          name: "Resumen",
          mimeType: "application/vnd.google-apps.document",
          origin: "created",
          addedAt: "2026-10-09T12:00:00Z",
        },
      ],
      disabled: false,
      picker: true,
    })
    expect(out).toContain("Plan de lanzamiento")
    expect(out).toContain("Documento de Google")
    expect(out).toContain("Creado por el agente")
    expect(out).toContain("Elegir archivos")
    expect(out).toContain('aria-label="Quitar Resumen"')
  })

  it("says the Picker is not configured instead of offering it", () => {
    const out = html(DriveFiles, {
      workspaceId: id(1),
      agentId: id(2),
      connectionId: id(3),
      files: [],
      disabled: false,
      picker: false,
    })
    expect(out).toContain("necesita completar su configuración")
    expect(out).toContain("Sin archivos elegidos")
  })

  it("lists each connected account as a tab with its tools on", () => {
    const out = html(DriveTools, {
      connections: [
        { id: id(3), account: "uno@example.invalid" },
        { id: id(4), account: "dos@example.invalid" },
      ],
      grant: { driveConnectionId: id(4), operations: ["drive.files.read"] },
      disabled: false,
      onPermission: () => {},
    })
    expect(out.match(/role="tab"/g)).toHaveLength(2)
    expect(out).toMatch(/dos@example\.invalid<span[^>]*>1\/4/)
    expect(out).toMatch(/uno@example\.invalid<span[^>]*>0\/4/)
  })

  it("puts Drive beside Gmail in Conexiones and Herramientas only when its state is loaded", () => {
    const base = {
      state: { connections: [], styleGuides: [] },
      workspaceId: id(1),
      agentId: id(2),
      tools: [],
      onTools: () => {},
      disabled: false,
    }
    expect(html(GmailConnection, base)).not.toContain("Conectar Google Drive")
    const out = html(GmailConnection, {
      ...base,
      drive: {
        connections: [
          {
            id: id(3),
            account: "drive@example.invalid",
            status: "connected",
            operations: [],
            files: [],
          },
        ],
        available: true,
        picker: true,
      },
    })
    // Each connect button shows a plus, the service's own mark and its name;
    // its accessible name still says what it does.
    for (const [label, name] of [
      ["Conectar Gmail", "Gmail"],
      ["Conectar Google Drive", "Google Drive"],
    ])
      expect(out).toMatch(
        new RegExp(
          `aria-label="${label}"[^>]*><svg[^>]*lucide-plus[\\s\\S]*?</svg><svg[\\s\\S]*?</svg>${name}</button>`
        )
      )
    expect(out).not.toContain(">Conectar Gmail<")
    expect(out).toContain("drive@example.invalid")
    expect(out).toContain("Drive de cada persona")
    expect(out).toContain("Permisos de mi cuenta de Drive")
    expect(
      html(GmailConnection, { ...base, drive: { connections: [] } })
    ).toContain("Crear documento")
    // Only Brave is told how to let Google's Picker work; the server never is.
    expect(out).not.toContain("Shields")
  })
})

describe("Conocimiento › Google Drive", () => {
  const file = (overrides: Record<string, unknown> = {}) => ({
    sourceId: id(10),
    collectionId: id(20),
    name: "Plan de lanzamiento",
    mimeType: "application/vnd.google-apps.document",
    url: `https://docs.google.com/document/d/${doc}/edit`,
    status: "synced",
    errorCode: null,
    checkedAt: "2026-10-09T12:00:00Z",
    syncedAt: "2026-10-09T12:00:00Z",
    modifiedAt: null,
    chunkCount: 3,
    account: "drive@example.invalid",
    connectionStatus: "connected",
    canManage: true,
    citedBy: [],
    ...overrides,
  })
  const render = (files: unknown[], connections: unknown[] = []) =>
    html(DriveImport, {
      workspaceId: id(1),
      state: { connections, files, available: true, picker: true },
      collections: [{ id: id(20), name: "Lanzamientos" }],
      collectionNames: { [id(20)]: "Lanzamientos" },
    })
  it("offers to connect a Drive account when there is none", () => {
    const out = render([])
    expect(out).toContain("Sin cuenta de Google Drive")
    expect(out).toContain("Conectar Google Drive")
    expect(out).not.toContain("<table")
  })
  it("shows each import with its state badge, collection and link to Drive", () => {
    const out = render(
      [
        file(),
        file({
          sourceId: id(11),
          status: "held",
          citedBy: [{ id: id(30), name: "Asistente" }],
        }),
        file({
          sourceId: id(12),
          status: "unavailable",
          errorCode: "trashed",
          url: null,
        }),
      ],
      [
        {
          id: id(3),
          account: "drive@example.invalid",
          status: "connected",
          files: 3,
        },
      ]
    )
    expect(out).toContain("Sincronizado")
    expect(out).toContain("Cambios en Drive sin aplicar")
    expect(out).toContain("Sin acceso en Drive")
    expect(out).toContain("Está en la papelera de Google Drive.")
    expect(out).toContain("Lanzamientos")
    expect(out).toContain(
      `href="https://docs.google.com/document/d/${doc}/edit"`
    )
    expect(out).toContain("Elegir archivos")
    expect(out).toContain("el cambio espera a que lo apliques")
  })
})

describe("Google's Picker", () => {
  // Google places the Picker from the window's scroll position, which put it
  // above the screen on a long page scrolled down to Conexiones.
  it("stays centred in the viewport, with its backdrop over the screen", () => {
    const css = readFileSync("packages/ui/src/styles/globals.css", "utf8")
    const rule = (selector: string) =>
      new RegExp(`\\${selector} \\{([^}]*)\\}`).exec(css)?.[1] ?? ""
    expect(rule(".picker-dialog")).toContain("position: fixed !important")
    expect(rule(".picker-dialog")).toContain("top: 50% !important")
    expect(rule(".picker-dialog-bg")).toContain("position: fixed !important")
    expect(rule(".picker-dialog-bg")).toContain("height: 100vh !important")
  })
})

describe("Where files are picked", () => {
  it("uses Google's page in Brave, Safari and on iPhone, and the in-page Picker elsewhere", () => {
    const on = (userAgent: string, brave = false) => {
      vi.stubGlobal(
        "navigator",
        brave ? { userAgent, brave: {} } : { userAgent }
      )
      return (pickOnGooglePage as unknown as () => boolean)()
    }
    const chrome =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
    expect(on(chrome)).toBe(false)
    expect(on(chrome, true)).toBe(true)
    expect(
      on(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15"
      )
    ).toBe(true)
    expect(on(`${chrome} Edg/154.0.0.0`)).toBe(false)
    expect(
      on(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0"
      )
    ).toBe(false)
    expect(
      on(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/154.0 Mobile/15E148 Safari/604.1"
      )
    ).toBe(true)
    vi.unstubAllGlobals()
  })
})
