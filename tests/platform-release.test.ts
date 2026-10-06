import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { createRequire } from "node:module"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
// @ts-expect-error -- plain ESM script without type declarations
import * as platformTree from "../scripts/platform-tree.mjs"
const { describeTree, releaseId, treeProblems } = platformTree
import {
  contentSecurityPolicy,
  nonce,
  nonceOf,
  securityHeaders,
} from "../packages/server/src/security"

const mocks = vi.hoisted(() => ({
  setAll: null as null | ((values: unknown[]) => void),
}))
vi.mock("server-only", () => ({}))
vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    options: { cookies: { setAll: (values: unknown[]) => void } }
  ) => ({
    auth: {
      getClaims: async () => {
        mocks.setAll = options.cookies.setAll
        options.cookies.setAll([
          {
            name: "agentonic-customer-auth",
            value: "refreshed",
            options: { httpOnly: true, path: "/" },
          },
        ])
        return { data: null, error: null }
      },
    },
  }),
}))
// next is a dependency of the server package, not of the repository root.
const { NextRequest } = createRequire(resolve("packages/server/package.json"))(
  "next/server"
) as {
  NextRequest: new (
    url: string,
    init?: { headers?: Record<string, string> }
  ) => Parameters<typeof refreshSession>[0]
}
import { refreshSession } from "../packages/server/src/proxy"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co")
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-public-key")
})
function tree() {
  const directory = mkdtempSync(join(tmpdir(), "agentonic-tree-"))
  roots.push(directory)
  mkdirSync(join(directory, "app/node_modules/.pnpm/x/node_modules/x"), {
    recursive: true,
  })
  writeFileSync(join(directory, "app/server.js"), "server")
  writeFileSync(
    join(directory, "app/node_modules/.pnpm/x/node_modules/x/index.js"),
    "x"
  )
  symlinkSync(".pnpm/x/node_modules/x", join(directory, "app/node_modules/x"))
  return directory
}

it("names every file and link of a release tree, and a release by its manifest", () => {
  const directory = tree()
  const described = describeTree(directory)
  expect(Object.keys(described.files)).toEqual([
    "app/node_modules/.pnpm/x/node_modules/x/index.js",
    "app/server.js",
  ])
  expect(described.links).toEqual({
    "app/node_modules/x": ".pnpm/x/node_modules/x",
  })
  expect(treeProblems(directory, described)).toEqual([])
  expect(releaseId(Buffer.from("{}"))).toMatch(/^[a-f0-9]{64}$/)
})

it("reports changed, missing and unexpected files and changed links", () => {
  const directory = tree()
  const manifest = describeTree(directory)
  writeFileSync(join(directory, "app/server.js"), "tampered")
  writeFileSync(join(directory, "app/extra.js"), "extra")
  rmSync(join(directory, "app/node_modules/.pnpm/x/node_modules/x/index.js"))
  rmSync(join(directory, "app/node_modules/x"))
  symlinkSync("../server.js", join(directory, "app/node_modules/x"))
  expect(treeProblems(directory, manifest).sort()).toEqual([
    "changed app/node_modules/x",
    "changed app/server.js",
    "missing app/node_modules/.pnpm/x/node_modules/x/index.js",
    "unexpected app/extra.js",
  ])
})

it("refuses links that leave the release", () => {
  const directory = tree()
  symlinkSync("/etc/passwd", join(directory, "app/absolute"))
  expect(() => describeTree(directory)).toThrow("Link leaves the release")
  rmSync(join(directory, "app/absolute"))
  symlinkSync("../../outside", join(directory, "app/relative"))
  expect(() => describeTree(directory)).toThrow("Link leaves the release")
})

it("allows only the app's own nonce'd scripts and Google's consent screen as a form destination", () => {
  const value = nonce()
  expect(value).toMatch(/^[A-Za-z0-9+/]{22}==$/)
  expect(nonce()).not.toBe(value)
  const policy = contentSecurityPolicy(value)
  expect(policy).toContain(
    `script-src 'self' 'nonce-${value}' 'strict-dynamic'`
  )
  expect(policy).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/)
  expect(policy).toContain("frame-ancestors 'none'")
  expect(policy).toContain("form-action 'self' https://accounts.google.com")
  expect(policy).toContain("object-src 'none'")
  expect(nonceOf(policy)).toBe(value)
  expect(nonceOf(null)).toBeUndefined()
  expect(new Map(securityHeaders(false)).has("Strict-Transport-Security")).toBe(
    false
  )
  expect(new Map(securityHeaders(true)).get("Strict-Transport-Security")).toBe(
    "max-age=63072000; includeSubDomains"
  )
})

it("gives production pages a nonce policy, keeps refreshed sessions, and leaves API policies to the route", async () => {
  vi.stubEnv("NODE_ENV", "production")
  const page = await refreshSession(
    new NextRequest("https://app.example.test/agents", {
      headers: { cookie: "agentonic-customer-auth=old" },
    }),
    "customer"
  )
  const policy = page.headers.get("content-security-policy") ?? ""
  const value = nonceOf(policy)
  expect(value).toBeTruthy()
  // Next.js reads the nonce from the forwarded request headers.
  expect(page.headers.get("x-middleware-request-content-security-policy")).toBe(
    policy
  )
  expect(page.headers.get("x-middleware-request-cookie")).toContain(
    "agentonic-customer-auth=refreshed"
  )
  expect(page.cookies.get("agentonic-customer-auth")?.value).toBe("refreshed")
  expect(page.headers.get("cache-control")).toBe("private, no-store")
  expect(page.headers.get("x-frame-options")).toBe("DENY")
  expect(page.headers.get("strict-transport-security")).toBeTruthy()
  const api = await refreshSession(
    new NextRequest("https://app.example.test/api/documents"),
    "customer"
  )
  expect(api.headers.get("content-security-policy")).toBeNull()
  expect(api.headers.get("x-content-type-options")).toBe("nosniff")
  vi.stubEnv("NODE_ENV", "development")
  const development = await refreshSession(
    new NextRequest("https://app.example.test/agents"),
    "customer"
  )
  expect(development.headers.get("content-security-policy")).toBeNull()
  expect(development.headers.get("strict-transport-security")).toBeNull()
})

it("pins each hosted service to one release, without privileges, behind a TLS proxy", async () => {
  // @ts-expect-error -- plain ESM script without type declarations
  const hosted = await import("../scripts/platform-units.mjs")
  const release = "a".repeat(64)
  const units = hosted.platformUnits(release) as Record<string, string>
  expect(Object.keys(units)).toEqual(["admin", "customer", "worker"])
  for (const [name, unit] of Object.entries(units)) {
    expect(unit).toContain(`${hosted.platformReleases}/${release}/${name}/`)
    expect(unit).toContain("DynamicUser=yes")
    expect(unit).toContain("NoNewPrivileges=yes")
    expect(unit).toContain("ProtectSystem=strict")
    expect(unit).toContain("CapabilityBoundingSet=\n")
    expect(unit).toContain("IPAddressDeny=169.254.169.254")
    expect(unit).toContain(
      `EnvironmentFile=${hosted.platformConfig}/${name}.env`
    )
    expect(unit).toContain("Environment=AGENTONIC_DATABASE_CA_FILE=%d/ca")
    expect(unit).toContain("StartLimitBurst=5")
    expect(unit).not.toMatch(/ReadWritePaths|User=root|SUPABASE_SECRET_KEY/)
  }
  expect(units.admin).toContain("Environment=HOSTNAME=127.0.0.1")
  expect(units.admin).toContain("Environment=PORT=3100")
  expect(units.customer).toContain("Environment=PORT=3101")
  expect(units.worker).toContain(
    "Environment=AGENTONIC_RUNTIME_ROOT=/opt/agentonic/runtime/artifacts"
  )
  expect(() => hosted.platformUnits("../etc")).toThrow("Invalid release id")
  const proxy = hosted.caddyfile() as string
  expect(proxy).toContain("admin off")
  expect(proxy).toContain(
    "app.agentonic.avilabs.tech {\n\tencode zstd gzip\n\trequest_body {\n\t\tmax_size 12MB\n\t}\n\theader -Server\n\treverse_proxy 127.0.0.1:3101\n}"
  )
  expect(proxy).toContain(
    "admin.agentonic.avilabs.tech {\n\tencode zstd gzip\n\trequest_body {\n\t\tmax_size 2MB\n\t}\n\theader -Server\n\treverse_proxy 127.0.0.1:3100\n}"
  )
})

it("keeps each app's session cookie on its own name, secure in production", async () => {
  vi.stubEnv("NODE_ENV", "production")
  const { authConfiguration } = await import("../packages/server/src/env")
  // No Domain attribute: the cookie stays on the exact host that set it.
  expect(authConfiguration("admin").cookieOptions).toEqual({
    name: "agentonic-admin-auth",
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
  })
  expect(authConfiguration("customer").cookieOptions.name).toBe(
    "agentonic-customer-auth"
  )
})
