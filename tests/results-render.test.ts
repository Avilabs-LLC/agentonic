import { describe, expect, it, vi } from "vitest"

// Resultados' chips and the situation frames, rendered on the server with
// synthetic configurations.
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
const { ConfigurationChips } = (await load(
  "../packages/ui/src/components/model-evaluation-dialog"
)) as Record<string, Component>
const { ReceiptTextFrame } = (await load(
  "../packages/ui/src/components/review-receipt-content"
)) as Record<string, Component>
const html = (component: unknown, props: Record<string, unknown>) =>
  (server.renderToStaticMarkup as (e: unknown) => string)(
    (react.createElement as (c: unknown, p: unknown) => unknown)(
      component,
      props
    )
  )

describe("Resultados", () => {
  it("gives each model and level its own chip, pressing only the chosen one", () => {
    const out = html(ConfigurationChips, {
      configurations: [
        { id: "a", label: "GPT-6 Astra · Bajo" },
        { id: "b", label: "GPT-6 Astra · Medio" },
        { id: "c", label: "GPT-6 Luna · Alto" },
      ],
      selected: "b",
      onSelect() {},
    })
    expect(out).toContain('aria-label="Modelos y niveles evaluados"')
    expect(out.match(/<button/g)).toHaveLength(3)
    expect(out.match(/aria-pressed="true"/g)).toHaveLength(1)
    expect(out).toMatch(/aria-pressed="true"[^>]*>GPT-6 Astra · Medio</)
    expect(out).toMatch(/aria-pressed="false"[^>]*>GPT-6 Astra · Bajo</)
  })

  it("titles a situation frame in muted text above its body", () => {
    const out = html(ReceiptTextFrame, {
      title: "Respuesta esperada",
      text: "Confirma el pedido con su número.",
      tone: "expected",
    })
    expect(out).toMatch(/<h3 class="[^"]*text-muted-foreground[^"]*">/)
    expect(out).toMatch(/<p class="(?![^"]*text-muted-foreground)[^"]*">/)
  })
})
