import { describe, expect, it } from "vitest"

// Loaded at run time: the root typecheck does not cover the UI package's JSX.
const load = (path: string) =>
  import(/* @vite-ignore */ path) as Promise<Record<string, unknown>>
const react = await load("../packages/ui/node_modules/react/index.js")
const server = await load(
  "../packages/ui/node_modules/react-dom/server.node.js"
)
const { RenewalLine } = (await load(
  "../packages/ui/src/components/agent-lifecycle"
)) as Record<string, (props: Record<string, unknown>) => unknown>
const html = (deployment: Record<string, unknown>) =>
  (server.renderToStaticMarkup as (e: unknown) => string)(
    (react.createElement as (c: unknown, p: unknown) => unknown)(RenewalLine, {
      deployment,
    })
  )
const base = {
  status: "running",
  expiresAt: "2026-11-07T12:00:00.000Z",
  autoRenew: true,
  renewsAt: "2026-11-04T12:00:00.000Z",
  periodBudgetUsd: 5,
  renewalBlocked: null,
}

// Ongoing authorization (architecture §59): one line says what happens next.
describe("renewal line", () => {
  it("says when an unchanged deployment renews and with what budget", () => {
    expect(html(base)).toContain("Se renovará automáticamente el 4/11/2026")
    expect(html(base)).toContain("USD 5.00 por período")
  })
  it("says when it will not renew, and why something changed", () => {
    expect(html({ ...base, autoRenew: false, renewsAt: null })).toContain(
      "No se renovará automáticamente; termina el"
    )
    expect(html({ ...base, renewalBlocked: "sources" })).toContain(
      "Cambiaron los documentos que respaldan esta versión"
    )
  })
  it("says nothing for a deployment that already ended", () => {
    expect(html({ ...base, status: "stopped" })).toBe("")
  })
})
