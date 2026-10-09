import { beforeEach, expect, it, vi } from "vitest"

// Picking Drive files on Google's own consent page (architecture §62), for
// browsers that keep Google's cookies from the Picker's frame. The database
// command, the cookie jar and Google are synthetic.
type Payload = Record<string, unknown>
const mocks = vi.hoisted(() => ({
  jar: new Map<string, string>(),
  calls: [] as { operation: string; payload: Record<string, unknown> }[],
  results: {} as Record<string, (payload: Record<string, unknown>) => unknown>,
}))
vi.mock("server-only", () => ({}))
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mocks.jar.has(name) ? { value: mocks.jar.get(name)! } : undefined,
    set: (name: string, value: string) =>
      value ? mocks.jar.set(name, value) : mocks.jar.delete(name),
  }),
}))
vi.mock("../packages/server/src/auth", () => ({
  requireVerifiedUser: async () => ({ authId: id(9) }),
}))
vi.mock("@agentonic/database/client", () => ({
  withIdentity: async (
    _user: string,
    _workspace: string,
    run: (tx: unknown) => unknown
  ) =>
    run({
      $queryRaw: async (_sql: unknown, operation: string, json: string) => {
        const payload = JSON.parse(json) as Payload
        mocks.calls.push({ operation, payload })
        const result = mocks.results[operation]
        if (!result) throw new Error(`unexpected ${operation}`)
        return [{ result: result(payload) }]
      },
    }),
}))
const { startDrive, finishDrive } = await import("../packages/server/src/drive")

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const workspace = id(1),
  agent = id(2),
  connection = id(3),
  doc = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
  gone = "1ZyXwVuTsRqPoNmLkJiHgFeDcBa987654"
const callback = "https://app.example.invalid/api/connections/google/callback"
const calls = (operation: string) =>
  mocks.calls.filter((c) => c.operation === operation)

beforeEach(() => {
  mocks.jar.clear()
  mocks.calls.length = 0
  vi.stubEnv("GOOGLE_CLIENT_ID", "123456789012-abc.apps.googleusercontent.com")
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret")
  vi.stubEnv("GOOGLE_REDIRECT_URI", callback)
  vi.stubEnv("AGENTONIC_CONNECTION_KEY", "ab".repeat(32))
  let credential = ""
  mocks.results = {
    credential: () => ({
      credential,
      account: "drive@example.invalid",
      purpose: "tools",
    }),
    "oauth.start": () => ({ ok: true }),
    "oauth.consume": () => ({
      purpose: "tools",
      agentId: agent,
      connectionId: id(4),
      verifier: calls("oauth.start")[0]!.payload.verifier,
    }),
    "oauth.target": () => ({ connectionId: connection }),
    "oauth.finish": (p) => {
      credential = String(p.credential)
      return { purpose: "tools", agentId: agent, connectionId: connection }
    },
    "files.add": () => ({ ok: true }),
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status })
      if (url === "https://oauth2.googleapis.com/token")
        return json({
          access_token: "synthetic-access",
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/drive.file",
          ...(String(init?.body).includes("authorization_code")
            ? { refresh_token: "synthetic-refresh" }
            : {}),
        })
      if (url.includes("/drive/v3/about"))
        return json({ user: { emailAddress: "drive@example.invalid" } })
      if (url.includes(`/files/${doc}?`))
        return json({
          id: doc,
          name: "Plan de lanzamiento",
          mimeType: "application/vnd.google-apps.document",
          version: "7",
        })
      if (url.includes(`/files/${gone}?`)) return json({}, 404)
      throw new Error(`unexpected fetch ${url}`)
    })
  )
})

it("asks Google for its file chooser, for the connected account only, with drive.file alone", async () => {
  const plain = new URL(await startDrive(workspace, "tools", agent))
  expect(plain.searchParams.has("trigger_onepick")).toBe(false)
  expect(plain.searchParams.has("login_hint")).toBe(false)
  const url = new URL(
    await startDrive(workspace, "tools", agent, { connectionId: connection })
  )
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    scope: "https://www.googleapis.com/auth/drive.file",
    prompt: "consent select_account",
    trigger_onepick: "true",
    allow_multiple: "true",
    login_hint: "drive@example.invalid",
  })
  expect(url.searchParams.get("mimetypes")).toContain(
    "application/vnd.google-apps.document"
  )
  expect(url.searchParams.has("include_granted_scopes")).toBe(false)
  // A knowledge connection never picks for an agent.
  await expect(
    startDrive(workspace, "knowledge", undefined, { connectionId: connection })
  ).rejects.toThrow()
})

it("keeps the files picked on Google's page after checking each with Drive", async () => {
  const start = new URL(
    await startDrive(workspace, "tools", agent, { connectionId: connection })
  )
  const back = new URL(callback)
  back.searchParams.set("state", start.searchParams.get("state")!)
  back.searchParams.set("code", "synthetic-code")
  back.searchParams.set("picked_file_ids", `${doc},${gone}`)
  const destination = await finishDrive(back)
  expect(destination.pathname).toBe(`/agents/${agent}`)
  expect(Object.fromEntries(destination.searchParams)).toMatchObject({
    drive: "picked",
    added: "1",
    refused: "1",
  })
  expect(calls("files.add").map((c) => c.payload)).toEqual([
    {
      agentId: agent,
      connectionId: connection,
      files: [
        {
          fileId: doc,
          name: "Plan de lanzamiento",
          mimeType: "application/vnd.google-apps.document",
        },
      ],
    },
  ])
})

it("ignores picked IDs on a plain connection", async () => {
  const start = new URL(await startDrive(workspace, "tools", agent))
  const back = new URL(callback)
  back.searchParams.set("state", start.searchParams.get("state")!)
  back.searchParams.set("code", "synthetic-code")
  back.searchParams.set("picked_file_ids", doc)
  const destination = await finishDrive(back)
  expect(destination.searchParams.get("drive")).toBe("connected")
  expect(calls("files.add")).toHaveLength(0)
})
