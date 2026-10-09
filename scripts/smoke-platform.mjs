import assert from "node:assert/strict"
import { execFileSync, fork, spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { root } from "./local-config.mjs"
// Starts the packed release from a fresh directory with placeholder settings
// and checks what needs no database (architecture §53): both servers start
// away from the build directory, pages carry the security headers and a nonce
// on every script, a browser reports no blocked script, signed-out visitors go
// to the login page, a foreign origin cannot upload, and the worker's PDF
// parser reads a PDF with the files the release ships.
const archive = process.argv[2] ?? join(root, "dist/platform/platform.tar.gz")
const directory = mkdtempSync(join(tmpdir(), "agentonic-smoke-"))
const children = []
const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}
try {
  execFileSync("tar", ["-xzf", archive, "-C", directory])
  const environment = {
    PATH: process.env.PATH,
    NODE_ENV: "production",
    HOSTNAME: "127.0.0.1",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: "https://smoke.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_smoke",
  }
  const apps = { admin: 3200, customer: 3201 }
  for (const [app, port] of Object.entries(apps)) {
    const child = spawn(
      process.execPath,
      [join(directory, app, "apps", app, "server.js")],
      { env: { ...environment, PORT: String(port) }, stdio: "ignore" }
    )
    children.push(child)
  }
  const base = (app) => `http://127.0.0.1:${apps[app]}`
  for (const app of Object.keys(apps)) {
    let healthy = false
    for (let i = 0; i < 60 && !healthy; i++) {
      healthy = await globalThis
        .fetch(`${base(app)}/api/health`)
        .then((r) => r.ok)
        .catch(() => false)
      if (!healthy) await new Promise((r) => globalThis.setTimeout(r, 500))
    }
    assert.ok(healthy, `${app} did not start`)
    const page = await globalThis.fetch(`${base(app)}/login`)
    const html = await page.text()
    check(page.status === 200, `${app} /login answered ${page.status}`)
    const policy = page.headers.get("content-security-policy") ?? ""
    const nonce = policy.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1]
    check(Boolean(nonce), `${app} /login has no nonce policy`)
    const scripts = html.match(/<script\b[^>]*>/g) ?? []
    check(scripts.length > 0, `${app} /login has no scripts`)
    for (const tag of scripts)
      check(
        tag.includes(`nonce="${nonce}"`),
        `${app} /login script without the nonce: ${tag.slice(0, 80)}`
      )
    for (const [name, value] of [
      ["x-frame-options", "DENY"],
      ["x-content-type-options", "nosniff"],
      // The customer app tells Google its origin and keeps the Picker's popup
      // linked (architecture §62); Admin does neither.
      [
        "referrer-policy",
        app === "customer" ? "strict-origin-when-cross-origin" : "same-origin",
      ],
      [
        "cross-origin-opener-policy",
        app === "customer" ? "same-origin-allow-popups" : "same-origin",
      ],
      ["cache-control", "private, no-store"],
      ["strict-transport-security", "max-age=63072000; includeSubDomains"],
    ])
      check(
        page.headers.get(name) === value,
        `${app} /login ${name}: ${page.headers.get(name)}`
      )
    check(!page.headers.get("x-powered-by"), `${app} names its framework`)
    // Signed out, the home page sends visitors to the login page: by status
    // or, once streaming has started, by the redirect Next.js writes inline.
    const signedOut = await globalThis.fetch(`${base(app)}/`, {
      redirect: "manual",
    })
    const body = await signedOut.text()
    check(
      ([303, 307].includes(signedOut.status) &&
        new URL(signedOut.headers.get("location") ?? "", base(app)).pathname ===
          "/login") ||
        (signedOut.status === 200 &&
          /NEXT_REDIRECT[^"]*\/login/.test(body) &&
          !body.includes('type="password"')),
      `${app} / signed out answered ${signedOut.status} ${signedOut.headers.get("location")}`
    )
    // A real browser reports any script the policy blocks.
    const chrome = ["google-chrome", "chromium"].find((name) => {
      try {
        execFileSync("which", [name], { stdio: "ignore" })
        return true
      } catch {
        return false
      }
    })
    if (chrome) {
      const result = await new Promise((resolve) => {
        const browser = spawn(
          chrome,
          [
            "--headless=new",
            "--no-sandbox",
            "--disable-gpu",
            "--enable-logging=stderr",
            "--v=0",
            "--virtual-time-budget=8000",
            "--dump-dom",
            `${base(app)}/login`,
          ],
          { stdio: ["ignore", "pipe", "pipe"] }
        )
        let out = "",
          err = ""
        browser.stdout.on("data", (d) => (out += d))
        browser.stderr.on("data", (d) => (err += d))
        browser.on("close", () => resolve({ out, err }))
      })
      check(
        !/Content Security Policy|Refused to (execute|load)/.test(result.err),
        `${app} /login: the browser blocked something:\n${result.err
          .split("\n")
          .filter((line) => /Content Security Policy|Refused/.test(line))
          .join("\n")}`
      )
      check(
        result.out.includes('type="password"'),
        `${app} /login did not render the form in the browser`
      )
    } else console.log("No Chrome found; skipped the browser check.")
  }
  const upload = await globalThis.fetch(`${base("customer")}/api/documents`, {
    method: "POST",
    headers: { Origin: "https://elsewhere.example" },
  })
  check(
    upload.status === 403,
    `foreign-origin upload answered ${upload.status}`
  )

  const parser = join(directory, "worker/pdf-parser.mjs")
  check(existsSync(parser), "the release has no PDF parser")
  const pages = await new Promise((resolve) => {
    const child = fork(parser, [], {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      env: { PATH: process.env.PATH },
    })
    child.on("message", (message) => resolve(message))
    child.on("exit", () => resolve({ error: "exited" }))
    child.send({ data: syntheticPdf().toString("base64") })
  })
  check(
    pages.pages?.[0]?.text?.includes("Synthetic smoke text"),
    `the worker's PDF parser answered ${JSON.stringify(pages).slice(0, 120)}`
  )
} finally {
  for (const child of children) child.kill("SIGTERM")
  rmSync(directory, { recursive: true, force: true })
}
if (failures.length) {
  console.error(failures.join("\n"))
  process.exit(1)
}
console.log("Release smoke checks passed.")

function syntheticPdf() {
  const stream =
    "BT /F1 12 Tf 50 750 Td (Synthetic smoke text for the release.) Tj ET"
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets = []
  for (const [i, body] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join(
      ""
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  return Buffer.from(pdf)
}
