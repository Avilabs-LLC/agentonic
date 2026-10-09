import { afterEach, expect, it, vi } from "vitest"
import { keyring, seal } from "../packages/connectors/src/secrets"
import type { Execute } from "../apps/worker/src/pipeline"
import {
  batches,
  ownText,
  phraseIndex,
  runStyleGuide,
  scrubGuide,
  StyleFailure,
  StyleStopped,
  usableMessage,
  type StyleJob,
} from "../apps/worker/src/style-guide"
// Aprender mi estilo (architecture §57): the worker side, with Gmail and the
// model mocked. Mail text must never reach the database.
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})
const account = "nico@example.invalid"
const keys = keyring("c".repeat(64))
const job: StyleJob = {
  id: "10000000-0000-4000-8000-000000000001",
  token: "10000000-0000-4000-8000-000000000002",
  kind: "style",
  connectionId: "10000000-0000-4000-8000-000000000003",
  windowDays: 90,
  maxMessages: 200,
}
const sent = (text: string, extra: Partial<Record<string, string>> = {}) => ({
  from: `Nico <${account}>`,
  to: "laura@cliente.invalid",
  cc: "",
  subject: "Re: Informe",
  autoSubmitted: "",
  reply: true,
  text,
  ...extra,
})

it("keeps only what the sender wrote: no quoted replies, forwards or signatures", () => {
  expect(
    ownText(
      "Hola Laura,\n\nTe lo envío el jueves.\n\nSaludos,\nNico\n--\nNico Johnson\nDirector\n"
    )
  ).toBe("Hola Laura,\n\nTe lo envío el jueves.\n\nSaludos,\nNico")
  expect(
    ownText(
      "Perfecto, gracias.\n\nEl lun, 5 oct 2026 a las 9:12, Laura <laura@example.invalid> escribió:\n> ¿Llega el jueves?"
    )
  ).toBe("Perfecto, gracias.")
  expect(
    ownText(
      "Sounds good.\n\nOn Mon, Oct 5, 2026 at 9:12 AM Laura <laura@example.invalid>\nwrote:\n> ok"
    )
  ).toBe("Sounds good.")
  expect(
    ownText(
      "Adjunto lo pedido.\n\nDe: Laura Pérez\nEnviado: lunes\nPara: Nico\nAsunto: Informe"
    )
  ).toBe("Adjunto lo pedido.")
  expect(ownText("Listo.\n> citado\nSigo aquí.")).toBe("Listo.\nSigo aquí.")
})

it("uses only messages the account wrote, never forwards or automatic replies, and keeps no addresses", () => {
  const text = "Laura, gracias por el avance. Lo reviso hoy y te confirmo."
  expect(usableMessage(sent(text), account)).toEqual({
    text,
    reply: true,
    recipients: 1,
    audience: "externa",
  })
  expect(
    usableMessage(
      sent(text, { to: "ana@example.invalid, pablo@otro.invalid" }),
      account
    )?.audience
  ).toBe("mixta")
  expect(
    usableMessage(sent(text, { from: "otra@example.invalid" }), account)
  ).toBeNull()
  expect(
    usableMessage(sent(text, { subject: "RV: Informe" }), account)
  ).toBeNull()
  expect(
    usableMessage(sent(text, { autoSubmitted: "auto-replied" }), account)
  ).toBeNull()
  expect(usableMessage(sent("Ok, gracias."), account)).toBeNull()
})

it("splits the mail into bounded analysis batches", () => {
  const m = (n: number) => ({
    text: "x".repeat(n),
    reply: false,
    recipients: 1,
    audience: "interna",
  })
  expect(
    batches(Array.from({ length: 31 }, () => m(100))).map((b) => b.length)
  ).toEqual([15, 15, 1])
  expect(batches([m(10000), m(10000), m(10000)]).map((b) => b.length)).toEqual([
    1, 1, 1,
  ])
})

it("removes guide lines that copy nine words from the mail, and every address", () => {
  const mail =
    "Te confirmo que el pedido llegará el jueves por la mañana sin falta."
  const guide = [
    "# Guía de estilo de escritura",
    "- Confirma plazos con frases breves.",
    "- Ejemplo: te confirmo que el pedido llegará el jueves por la mañana.",
    "- Escribe a laura@example.invalid con copia.",
  ].join("\n")
  expect(scrubGuide(guide, phraseIndex([mail]))).toBe(
    [
      "# Guía de estilo de escritura",
      "- Confirma plazos con frases breves.",
      "- Escribe a [correo] con copia.",
    ].join("\n")
  )
})

/** Gmail's answer to one read of message `n`, or undefined to deliver it. */
type GmailFault = (n: number, attempt: number) => Response | Error | undefined
function providers(texts: string[], fault?: GmailFault) {
  const calls: { url: string; at: number; body?: Record<string, unknown> }[] =
    []
  const attempts = new Map<number, number>()
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({
      url,
      at: Date.now(),
      body:
        typeof init?.body === "string" && init.body.startsWith("{")
          ? JSON.parse(init.body)
          : undefined,
    })
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return Response.json({ access_token: "access", expires_in: 3600 })
    if (url.includes("/messages?"))
      return Response.json({
        messages: texts.map((_, i) => ({ id: `m${i}`, threadId: `t${i}` })),
      })
    const read = /\/messages\/m(\d+)\?format=full/.exec(url)
    if (read) {
      const n = Number(read[1]),
        attempt = (attempts.get(n) ?? 0) + 1
      attempts.set(n, attempt)
      const failure = fault?.(n, attempt)
      if (failure instanceof Error) throw failure
      if (failure) return failure
      return Response.json({
        id: `m${n}`,
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "From", value: `Nico <${account}>` },
            { name: "To", value: "laura@example.invalid" },
            { name: "Subject", value: "Re: Informe" },
          ],
          body: {
            data: Buffer.from(texts[n]!).toString("base64url"),
          },
        },
      })
    }
    // The model: observations for each batch, then the guide.
    const body = calls.at(-1)!.body!
    const markdown = String(body.instructions).startsWith("Redactas")
    return Response.json({
      status: "completed",
      usage: { input_tokens: 1000, output_tokens: 200 },
      output: [
        {
          content: [
            {
              type: "output_text",
              text: JSON.stringify(
                markdown
                  ? {
                      markdown:
                        "# Guía de estilo de escritura\n\n## Tono\n\nCercano y directo.",
                    }
                  : {
                      observations: [
                        { aspect: "tono", note: "Cercano y directo." },
                      ],
                    }
              ),
            },
          ],
        },
      ],
    })
  })
  vi.stubGlobal("fetch", fetch)
  return calls
}
const config = {
  google: {
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://example.invalid/api/connections/google/callback",
    keys,
  },
  openaiKey: "synthetic-key",
}
function database() {
  const calls: [string, Record<string, unknown>][] = []
  const execute = vi.fn<Execute>(async (operation, _job, payload = {}) => {
    calls.push([operation, payload])
    if (operation === "credential")
      return {
        credential: seal(
          { refreshToken: "refresh" },
          `gmail:${job.connectionId}`,
          keys
        ),
        account,
        connectionId: job.connectionId,
      }
    return { ok: true }
  })
  return { execute, calls }
}

it("drafts a guide from the account's sent mail and sends the database counts only", async () => {
  const texts = Array.from(
    { length: 6 },
    (_, i) =>
      `Laura, gracias por el avance número ${i}. Lo reviso esta tarde y te confirmo mañana temprano.`
  )
  const calls = providers(texts)
  const { execute, calls: stored } = database()
  await runStyleGuide(job, execute, config, new AbortController().signal)
  expect(
    new URL(
      calls.find((c) => c.url.includes("/messages?"))!.url
    ).searchParams.get("q")
  ).toBe("in:sent newer_than:90d -in:chats")
  const model = calls.filter((c) => c.url.includes("api.openai.com"))
  expect(model).toHaveLength(2)
  expect(model[0]!.body).toMatchObject({
    model: "gpt-5.4-mini",
    reasoning: { effort: "low" },
    store: false,
  })
  // The analysis sees the text but no address or subject.
  expect(String(model[0]!.body!.input)).toContain("gracias por el avance")
  expect(String(model[0]!.body!.input)).not.toContain("@example.invalid")
  expect(String(model[0]!.body!.input)).not.toContain("Informe")
  expect(stored.map(([operation]) => operation)).toEqual([
    "credential",
    "progress",
    "progress",
    "progress",
    "reserve",
    "settle",
    "progress",
    "progress",
    "reserve",
    "settle",
    "ready",
  ])
  expect(stored.at(-1)![1]).toEqual({
    guide: "# Guía de estilo de escritura\n\n## Tono\n\nCercano y directo.",
  })
  // No step stores any of the mail.
  const recorded = JSON.stringify(stored.slice(0, -1))
  for (const text of texts) expect(recorded).not.toContain(text.slice(0, 20))
  expect(stored[2]![1]).toEqual({ status: "reading", messagesRead: 6 })
})

it("stops before the analysis when there is too little mail, and asks to reconnect when Google refuses", async () => {
  providers(["Laura, gracias por el avance. Lo reviso y te confirmo."])
  const { execute, calls } = database()
  await expect(
    runStyleGuide(job, execute, config, new AbortController().signal)
  ).rejects.toThrow("not_enough_mail")
  expect(calls.map(([operation]) => operation)).not.toContain("reserve")
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}", { status: 400 }))
  )
  const second = database()
  await expect(
    runStyleGuide(job, second.execute, config, new AbortController().signal)
  ).rejects.toBeInstanceOf(StyleStopped)
  expect(second.calls.map(([operation]) => operation)).toEqual([
    "credential",
    "reconnect",
  ])
})

// Gmail fails now and then over hundreds of reads in a row (a 9 October run
// stopped at 100 of 200 on one such error): retries wait on fake timers.
const mail = (count: number) =>
  Array.from(
    { length: count },
    (_, i) =>
      `Laura, gracias por el avance número ${i}. Lo reviso esta tarde y te confirmo mañana temprano.`
  )
const status = (code: number, headers: Record<string, string> = {}) =>
  new Response('{"error":{"code":' + code + "}}", { status: code, headers })
async function settle<T>(run: Promise<T>) {
  let done = false
  run.then(
    () => (done = true),
    () => (done = true)
  )
  while (!done) await vi.advanceTimersByTimeAsync(250)
  return run
}
const reads = (calls: { url: string; at: number }[], n: number) =>
  calls.filter((c) => c.url.includes(`/messages/m${n}?format=full`))

it("retries a passing Gmail error, waiting as long as Gmail asks", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  const calls = providers(mail(6), (n, attempt) => {
    if (attempt > 1) return undefined
    if (n === 1) return status(503)
    if (n === 2) return status(429, { "Retry-After": "2" })
    if (n === 3)
      return new Response(
        '{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}',
        { status: 403 }
      )
    if (n === 4) return new TypeError("fetch failed")
  })
  const { execute, calls: stored } = database()
  await expect(
    settle(runStyleGuide(job, execute, config, new AbortController().signal))
  ).resolves.toEqual({ skipped: 0 })
  for (const n of [1, 2, 3, 4]) expect(reads(calls, n)).toHaveLength(2)
  expect(reads(calls, 0)).toHaveLength(1)
  const [first, second] = reads(calls, 2)
  expect(second!.at - first!.at).toBe(2000)
  expect(stored.find(([, p]) => p.status === "analyzing")![1]).toMatchObject({
    messagesUsed: 6,
  })
  expect(stored.at(-1)![0]).toBe("ready")
})

it("skips a message Gmail will not hand over and keeps the run going", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  const calls = providers(mail(9), (n) => {
    if (n === 1) return status(404)
    if (n === 3) return Response.json({ padding: "x".repeat(2_100_000) })
    if (n === 5) return status(503)
  })
  const { execute, calls: stored } = database()
  await expect(
    settle(runStyleGuide(job, execute, config, new AbortController().signal))
  ).resolves.toEqual({ skipped: 3 })
  // Gone or too large stays that way; only the passing error is retried.
  expect(reads(calls, 1)).toHaveLength(1)
  expect(reads(calls, 3)).toHaveLength(1)
  expect(reads(calls, 5)).toHaveLength(5)
  expect(stored.find(([, p]) => p.messagesRead === 9)).toBeDefined()
  expect(stored.find(([, p]) => p.status === "analyzing")![1]).toMatchObject({
    messagesUsed: 6,
  })
  expect(stored.at(-1)![0]).toBe("ready")
})

it("gives up when Gmail keeps failing, naming the error for the journal only", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  providers(mail(10), (n) => (n >= 2 && n <= 4 ? status(503) : undefined))
  const { execute, calls } = database()
  const failed = await settle(
    runStyleGuide(job, execute, config, new AbortController().signal)
  ).catch((error: unknown) => error)
  expect(failed).toBeInstanceOf(StyleFailure)
  expect(failed).toMatchObject({
    message: "gmail_unavailable",
    diagnostic: "gmail_http_503",
  })
  expect(calls.map(([operation]) => operation)).not.toContain("reserve")
  // More than 20 skipped in all also stops the run, even never three in a row.
  providers(mail(50), (n) => (n % 2 ? status(404) : undefined))
  const scattered = database()
  await expect(
    settle(
      runStyleGuide(
        job,
        scattered.execute,
        config,
        new AbortController().signal
      )
    )
  ).rejects.toMatchObject({
    message: "gmail_unavailable",
    diagnostic: "gmail_http_404",
  })
  expect(
    scattered.calls.filter(([operation]) => operation === "progress").at(-1)![1]
  ).toEqual({ status: "reading", messagesRead: 40 })
})

it("stops waiting for Gmail when the lease is lost, and asks to reconnect on a 401", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
  const lease = new AbortController()
  providers(mail(6), (n) => {
    if (n !== 1) return undefined
    lease.abort()
    return status(503)
  })
  await expect(
    settle(runStyleGuide(job, database().execute, config, lease.signal))
  ).rejects.toThrow("lease_lost")
  providers(mail(6), (n) => (n === 2 ? status(401) : undefined))
  const { execute, calls } = database()
  await expect(
    settle(runStyleGuide(job, execute, config, new AbortController().signal))
  ).rejects.toBeInstanceOf(StyleStopped)
  expect(calls.map(([operation]) => operation)).toEqual([
    "credential",
    "progress",
    "reconnect",
  ])
})
