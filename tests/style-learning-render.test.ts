import { describe, expect, it } from "vitest"

// Loaded at run time: the root typecheck does not cover the UI package's JSX.
const load = (path: string) =>
  import(/* @vite-ignore */ path) as Promise<Record<string, unknown>>
const react = await load("../packages/ui/node_modules/react/index.js")
const server = await load(
  "../packages/ui/node_modules/react-dom/server.node.js"
)
const { StyleLearning } = (await load(
  "../packages/ui/src/components/style-learning"
)) as Record<string, (props: Record<string, unknown>) => unknown>
const { GmailAccount } = (await load(
  "../packages/ui/src/components/gmail-connection"
)) as Record<string, (props: Record<string, unknown>) => unknown>
const html = (component: unknown, props: Record<string, unknown>) =>
  (server.renderToStaticMarkup as (e: unknown) => string)(
    (react.createElement as (c: unknown, p: unknown) => unknown)(
      component,
      props
    )
  )
const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const connection = { id: id(1), account: "nico@example.invalid" }
const base = {
  id: id(2),
  connectionId: id(1),
  status: "queued",
  messagesRead: 0,
  messagesTotal: null,
  messagesUsed: null,
  batchesDone: 0,
  batchesTotal: null,
  budgetUsd: 0.5,
  committedMicrousd: 0,
  errorCode: null,
  createdAt: "2026-10-08T12:00:00.000Z",
  startedAt: null,
  finishedAt: null,
  expiresAt: null,
  guide: null,
  document: null,
}
const row = (initial?: Record<string, unknown>) =>
  html(StyleLearning, {
    workspaceId: id(9),
    agentId: id(8),
    connection,
    initial,
    collections: [{ id: id(7), name: "Correo" }],
    agentCollectionIds: [id(7)],
    disabled: false,
  })

// Aprender mi estilo (architecture §57), rendered in each observed state.
describe("Aprender mi estilo", () => {
  it("offers the run as a distinct round box before anything has run", () => {
    const out = row()
    expect(out).toContain("Aprender mi estilo de escritura")
    expect(out).toContain("rounded-full")
    expect(out).not.toContain("animate-spin")
  })
  it("never spins for a queued run, and counts real progress while reading", () => {
    const queued = row(base)
    expect(queued).toContain("En cola")
    expect(queued).toContain("Empezará en cuanto haya un turno libre.")
    expect(queued).not.toContain("animate-spin")
    const reading = row({
      ...base,
      status: "reading",
      messagesRead: 120,
      messagesTotal: 200,
    })
    expect(reading).toContain("Leyendo tus correos enviados")
    expect(reading).toContain("120 de 200")
    expect(reading).toContain("animate-spin")
    expect(reading).toContain('aria-valuenow="60"')
    expect(reading).toContain("Puedes cerrar esta página")
  })
  it("asks for review when ready, shows the document once added, and explains a failure", () => {
    const ready = row({
      ...base,
      status: "ready",
      guide: "# Guía de estilo de escritura",
      committedMicrousd: 120000,
      expiresAt: "2026-10-15T12:00:00.000Z",
    })
    expect(ready).toContain("Revisar guía")
    expect(ready).toContain("Lista para revisar")
    expect(ready).not.toContain("animate-spin")
    const accepted = row({
      ...base,
      status: "accepted",
      document: {
        objectId: id(6),
        title: "Guía de estilo de escritura.md",
        collectionId: id(7),
        collection: "Correo",
      },
    })
    expect(accepted).toContain("Agregada a Conocimiento")
    expect(accepted).toContain("en la colección Correo")
    expect(accepted).toContain("motion-reduce:animate-none")
    const failed = row({
      ...base,
      status: "failed",
      errorCode: "not_enough_mail",
    })
    expect(failed).toContain("No encontramos suficientes correos")
    expect(failed).toContain("Aprender mi estilo de escritura")
  })
  it("marks a connected Gmail account with its logo and a check", () => {
    const out = html(GmailAccount, {
      account: connection.account,
      status: "connected",
    })
    expect(out).toContain("#e53935")
    expect(out).toMatch(/lucide-circle-check[^>]*>[\s\S]*?Cuenta conectada/)
    expect(
      html(GmailAccount, { account: connection.account, status: "reconnect" })
    ).toContain("Necesita volver a conectarse")
    // A consent past its date asks for a reconnect before Google refuses (§84).
    expect(
      html(GmailAccount, {
        account: connection.account,
        status: "connected",
        expiresAt: "2026-01-01T12:00:00.000Z",
      })
    ).toMatch(
      /lucide-triangle-alert[^>]*>[\s\S]*?La autorización de Google venció el 1\/1\/2026/
    )
  })
})
