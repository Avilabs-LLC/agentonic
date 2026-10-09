// Checks the hosted apps from outside the VM with no credentials (architecture
// §53). `pnpm hosted:check` runs every check; the GitHub alert runs the basic
// ones every six hours, so a stopped app, proxy or certificate raises an issue
// even while the Mac is off. Problems never include response bodies.
const services = { customer: "agentonic-customer", admin: "agentonic-admin" }

export async function hostedProblems(hostnames, { full = false } = {}) {
  const problems = []
  const get = (url, init = {}) =>
    globalThis
      .fetch(url, {
        redirect: "manual",
        signal: globalThis.AbortSignal.timeout(15000),
        ...init,
      })
      .catch((error) => ({ failed: error.cause?.code ?? error.name }))
  for (const [app, name] of Object.entries(hostnames)) {
    const label = `${app === "admin" ? "the Admin app" : "the customer app"} (${name})`
    const base = `https://${name}`
    const health = await get(`${base}/api/health`)
    if (health.failed) {
      problems.push(`${label} cannot be reached over HTTPS (${health.failed})`)
      continue
    }
    const service = await health
      .json()
      .then((body) => body?.service)
      .catch(() => null)
    if (health.status !== 200 || service !== services[app])
      problems.push(`${label} health check answered ${health.status}`)
    const login = await get(`${base}/login`)
    if (login.failed || login.status !== 200)
      problems.push(
        `${label} login page answered ${login.status ?? login.failed}`
      )
    else {
      const policy = login.headers.get("content-security-policy") ?? ""
      if (
        !/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/.test(
          policy
        )
      )
        problems.push(`${label} login page has no script policy`)
      if (!login.headers.get("strict-transport-security"))
        problems.push(`${label} login page has no HSTS header`)
    }
    if (!full) continue
    const plain = await get(`http://${name}/login`)
    if (
      plain.failed ||
      ![301, 308].includes(plain.status) ||
      !plain.headers.get("location")?.startsWith(`https://${name}/`)
    )
      problems.push(`${label} does not redirect plain HTTP to HTTPS`)
    if (!login.failed) {
      for (const [header, value] of [
        ["x-frame-options", "DENY"],
        ["x-content-type-options", "nosniff"],
        [
          "referrer-policy",
          app === "customer"
            ? "strict-origin-when-cross-origin"
            : "same-origin",
        ],
        [
          "cross-origin-opener-policy",
          app === "customer" ? "same-origin-allow-popups" : "same-origin",
        ],
        ["cache-control", "private, no-store"],
      ])
        if (login.headers.get(header) !== value)
          problems.push(
            `${label} login page ${header} is ${login.headers.get(header)}`
          )
      for (const header of ["server", "x-powered-by"])
        if (login.headers.get(header))
          problems.push(`${label} names its software (${header})`)
      if (login.headers.get("set-cookie"))
        problems.push(`${label} sets a cookie for a signed-out visitor`)
    }
    const home = await get(`${base}/`)
    if (
      home.failed ||
      ![303, 307].includes(home.status) ||
      new URL(home.headers.get("location") ?? "", base).pathname !== "/login"
    )
      problems.push(`${label} shows its home page to a signed-out visitor`)
  }
  if (full && hostnames.customer && hostnames.admin) {
    const customer = `https://${hostnames.customer}`
    // Signed out, a well-formed same-origin request (it passes validation and
    // reaches the session check) is refused and carries no data.
    const chats = await get(
      `${customer}/api/chats?workspace=00000000-0000-4000-8000-000000000000`,
      {
        method: "POST",
        headers: { Origin: customer, "Content-Type": "application/json" },
        body: JSON.stringify({ operation: "list", payload: {} }),
      }
    )
    const refused = chats.failed
      ? null
      : await chats
          .json()
          .then(
            (body) =>
              body?.error === "unavailable" && Object.keys(body).length === 1
          )
          .catch(() => false)
    if (chats.failed || chats.status < 400 || !refused)
      problems.push(
        `a signed-out chat request answered ${chats.status ?? chats.failed}`
      )
    // Another origin, even the Admin app's, cannot upload or start a connection.
    for (const path of ["/api/documents", "/api/connections/google/start"]) {
      const foreign = await get(`${customer}${path}`, {
        method: "POST",
        headers: { Origin: `https://${hostnames.admin}` },
      })
      if (foreign.status !== 403)
        problems.push(
          `a cross-origin POST to ${path} answered ${foreign.status ?? foreign.failed}`
        )
    }
  }
  return problems
}
