import { describe, expect, it, vi } from "vitest"

// Configuración polish (owner direction, 2026-10-09): Markdown texts with two
// sides, Gmail accounts as tabs, and version frames that line up.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }))
// Loaded at run time: the root typecheck does not cover the UI package's JSX.
const load = (path: string) =>
  import(/* @vite-ignore */ path) as Promise<Record<string, unknown>>
type Component = (props: Record<string, unknown>) => unknown
const react = await load("../packages/ui/node_modules/react/index.js")
const server = await load(
  "../packages/ui/node_modules/react-dom/server.node.js"
)
const { Markdown, MarkdownField, MarkdownView } = (await load(
  "../packages/ui/src/components/markdown"
)) as Record<string, Component>
const { GmailTools, GmailConnection } = (await load(
  "../packages/ui/src/components/gmail-connection"
)) as Record<string, Component>
const { VersionCards } = (await load(
  "../packages/ui/src/components/agent-workflow"
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
const text = "## Tono\n\nFrases **cortas**.\n\n- Saluda\n- Despide"

describe("Markdown texts", () => {
  it("renders Markdown without raw HTML, remote images or script links", () => {
    const out = html(Markdown, {
      children: [
        "# Guía",
        "<script>alert(1)</script>",
        "![logo](https://tracker.example.invalid/pixel.png)",
        "[enlace](https://example.invalid) [malo](javascript:alert(1))",
        "| Rasgo | Ejemplo |\n|---|---|\n| Tono | Cercano |",
      ].join("\n\n"),
    })
    expect(out).toContain("<h1")
    expect(out).toContain("<table")
    expect(out).not.toContain("<script")
    expect(out).toContain("&lt;script&gt;")
    expect(out).not.toContain("<img")
    expect(out).toContain("logo")
    expect(out).toContain('href="https://example.invalid"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).not.toContain("javascript:")
  })

  it("opens a field on its preview and keeps the textarea mounted", () => {
    const out = html(MarkdownField, {
      id: "guide",
      label: "Guía",
      markdown: text,
      paneClassName: "h-[min(24rem,45dvh)]",
      value: text,
      onChange: () => {},
    })
    expect(out).toContain("Vista previa")
    expect(out).toMatch(/aria-selected="true"[^>]*>Vista previa/)
    expect(out).toContain("<strong>cortas</strong>")
    expect(out).toMatch(/<textarea[^>]*h-\[min\(24rem,45dvh\)\]/)
    expect(out).toContain('id="guide"')
  })

  it("opens an empty field on its raw text", () => {
    const out = html(MarkdownField, {
      id: "prompt",
      label: "Instrucciones",
      markdown: "  ",
      paneClassName: "min-h-52",
    })
    expect(out).toMatch(/aria-selected="true"[^>]*>Texto/)
  })

  it("shows frozen text both rendered and exactly as written", () => {
    const out = html(MarkdownView, {
      markdown: text,
      paneClassName: "max-h-[min(32rem,60dvh)]",
    })
    expect(out).toContain("<strong>cortas</strong>")
    expect(out).toContain("Frases **cortas**.")
    expect(out).toContain("max-h-[min(32rem,60dvh)]")
  })
})

const accounts = Array.from({ length: 15 }, (_, i) => ({
  id: id(10 + i),
  account: `cuenta${i + 1}@example.invalid`,
}))
describe("Herramientas › Gmail", () => {
  it("lists each connected account as a tab with its tools on", () => {
    const out = html(GmailTools, {
      connections: accounts,
      grant: {
        connectionId: id(11),
        operations: ["gmail.search", "gmail.read"],
      },
      disabled: false,
      onPermission: () => {},
    })
    expect(out.match(/role="tab"/g)).toHaveLength(15)
    expect(out).toContain("cuenta2@example.invalid")
    expect(out).toMatch(/cuenta2@example\.invalid<span[^>]*>2\/9/)
    expect(out).toMatch(/cuenta1@example\.invalid<span[^>]*>0\/9/)
    expect(out).toContain(">15<span")
    expect(out).toContain("cuentas conectadas")
    expect(out).toContain("overflow-x-auto")
    expect(out).not.toContain("Cuenta:")
  })

  it("asks for an account when none is connected", () => {
    const out = html(GmailTools, {
      connections: [],
      grant: undefined,
      disabled: false,
      onPermission: () => {},
    })
    expect(out).toContain("Conecta una cuenta primero")
    expect(out).not.toContain('role="tab"')
  })

  it("labels web access read-only in one short note", () => {
    const out = html(GmailConnection, {
      state: { connections: [], styleGuides: [] },
      workspaceId: id(1),
      agentId: id(2),
      tools: [],
      onTools: () => {},
      disabled: false,
    })
    expect(out).toContain("Acceso web")
    expect(out).toContain("Solo lectura")
    expect(out).not.toContain("No inicia sesión")
  })
})

describe("Version frames", () => {
  const candidate = {
    id: id(1),
    version: "3",
    revision: 6,
    hash: "a",
    codeReleaseId: id(2),
    canSubmit: true,
    canPreview: true,
    number: 3,
    createdAt: "2026-10-08T12:00:00.000Z",
  }
  const cards = (dirty: boolean, submitted: boolean) =>
    html(VersionCards, {
      base: {
        draft: {
          revision: 7,
          content: { systemPrompt: "x".repeat(300), skills: [] },
          requestedAccess: { collectionIds: [], tools: [] },
        },
        editor: { dirty, valid: true, pending: false, editingSkill: false },
        candidates: [candidate],
        submittedCandidateIds: submitted ? [candidate.id] : [],
        availableCollectionIds: [],
        availableCodeIds: [id(2)],
        busy: false,
      },
      run: async () => {},
      message: "",
      pendingAction: null,
    })

  it("gives both frames a four-line body and a violet state note", () => {
    const out = cards(true, true)
    expect(out.match(/min-h-\[calc\(4lh\+2rem\)\]/g)).toHaveLength(2)
    expect(out).toMatch(
      /text-\[0\.8125rem\] text-highlight">Cambios sin guardar/
    )
    expect(out).toMatch(
      /text-\[0\.8125rem\] text-highlight">Enviada a revisión/
    )
  })
})
