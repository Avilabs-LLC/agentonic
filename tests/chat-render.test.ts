import { describe, expect, it, vi } from "vitest"

// What a chat shows (architecture §81), rendered on the server with synthetic
// answers and actions.
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
const { AgentAnswer } = (await load(
  "../packages/ui/src/components/agent-answer"
)) as Record<string, Component>
const { GmailReview } = (await load(
  "../packages/ui/src/components/gmail-approvals"
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
const draft = (message: Record<string, unknown>) => ({
  id: id(1),
  account: "owner@example.invalid",
  operation: "gmail.drafts.create",
  arguments: {
    to: ["client@example.invalid"],
    cc: [],
    bcc: [],
    subject: "Re: Cotización",
    body: "Gracias por escribir.",
    ...message,
  },
  hash: "a".repeat(64),
  status: "pending",
  expiresAt: "2026-10-15T12:00:00.000Z",
})

describe("Chats › answers", () => {
  it("renders the answer's Markdown and keeps its single line breaks", () => {
    const out = html(AgentAnswer, {
      text: "**Listo.**\nPreparé 2 borradores:\n\n- Ana\n- Luis",
    })
    expect(out).toContain("<strong>Listo.</strong>")
    expect(out).toMatch(/<li[^>]*>Ana<\/li>/)
    expect(out).toContain("whitespace-pre-line")
    expect(out).not.toContain("**")
  })

  it("names the site a link opens and never follows other schemes", () => {
    const out = html(AgentAnswer, {
      text: "[Tu banco](https://phish.example.invalid/login), https://docs.example.invalid y [correo](mailto:a@example.invalid) <b>x</b>",
    })
    expect(out).toContain("(phish.example.invalid)")
    // A bare link already shows its site.
    expect(out).not.toContain("(docs.example.invalid)")
    expect(out).not.toContain("mailto:")
    expect(out).not.toContain("<b>")
  })
})

describe("Chats › Gmail action review", () => {
  it("shows a reply's conversation, its draft and the agent's note as tabs", () => {
    const out = html(GmailReview, {
      workspaceId: id(9),
      item: draft({ replyTo: "m-1", note: "Confirma el precio." }),
    })
    expect(out).toContain("Conversación")
    expect(out).toContain("Borrador")
    expect(out).toContain("Notas")
    // The conversation opens first and is read from Gmail on the client.
    expect(out).toContain("Cargando la conversación")
  })

  it("keeps a new message without a note as it was, with no tabs", () => {
    const out = html(GmailReview, {
      workspaceId: id(9),
      item: draft({ replyTo: null }),
    })
    expect(out).not.toContain('role="tablist"')
    expect(out).toContain("Gracias por escribir.")
  })
})
