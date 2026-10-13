import { afterEach, expect, it, vi } from "vitest"
import { gmailMessage, parseGmailCall } from "../packages/contracts/src/gmail"
import {
  gmail,
  rawMessage,
  exchange,
  GOOGLE_SCOPES,
} from "../packages/connectors/src/google"
import { keyring, seal, unseal } from "../packages/connectors/src/secrets"
import { executeGmail } from "../apps/worker/src/gmail"
import { toolParameters } from "../apps/worker/src/broker"
const key = "a".repeat(64),
  id = "10000000-0000-4000-8000-000000000001"
const message = {
  to: ["synthetic@example.invalid"],
  cc: [],
  bcc: [],
  subject: "Prueba ñ",
  body: "Texto sintético",
}
afterEach(() => vi.unstubAllGlobals())
it("binds authenticated ciphertext to its exact record and key", () => {
  const ciphertext = seal({ refreshToken: "synthetic" }, `gmail:${id}`, key)
  expect(ciphertext).not.toContain("synthetic")
  expect(unseal(ciphertext, `gmail:${id}`, key)).toEqual({
    refreshToken: "synthetic",
  })
  expect(() => unseal(ciphertext, "another-record", key)).toThrow()
  expect(() => unseal(ciphertext, `gmail:${id}`, "b".repeat(64))).toThrow()
})
it("rejects header injection, unknown tools, URLs as IDs and unsupported attachments", () => {
  expect(
    gmailMessage.safeParse({
      ...message,
      subject: "Subject\r\nBcc: attacker@example.invalid",
    }).success
  ).toBe(false)
  expect(() =>
    parseGmailCall("gmail.read", { id: "https://evil.invalid" })
  ).toThrow()
  expect(() => parseGmailCall("gmail.delete", { id: "abc" })).toThrow()
  expect(gmailMessage.safeParse({ ...message, attachments: [] }).success).toBe(
    false
  )
  const raw = Buffer.from(
    rawMessage(message, "sender@example.invalid", id),
    "base64url"
  ).toString()
  expect(raw).toContain(`Message-ID: <${id}@agentonic.invalid>`)
  expect(raw).toContain("Content-Type: text/plain")
})
it("requires both scopes and offline refresh authority", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        access_token: "synthetic",
        expires_in: 3600,
        scope: GOOGLE_SCOPES[0],
      })
    )
  )
  await expect(
    exchange(
      {
        clientId: "test",
        clientSecret: "test",
        redirectUri: "http://localhost:3101/api/connections/google/callback",
        keys: keyring(key),
      },
      "code",
      "verifier"
    )
  ).rejects.toThrow("reconnect")
})
it("never automatically retries a send with an unknown outcome", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("timeout"))
  vi.stubGlobal("fetch", fetch)
  await expect(
    gmail("synthetic", "gmail.send", message, "sender@example.invalid", id)
  ).rejects.toThrow("uncertain")
  expect(fetch).toHaveBeenCalledTimes(1)
})
it("does not expose provider HTML, attachments or arbitrary metadata", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        id: "123",
        snippet: "Preview",
        payload: {
          mimeType: "text/html",
          body: {
            data: Buffer.from("<script>bad</script>").toString("base64url"),
          },
          headers: [
            { name: "Subject", value: "Test" },
            { name: "X-Secret", value: "secret" },
          ],
        },
      })
    )
  )
  const result = await gmail(
    "synthetic",
    "gmail.read",
    { id: "123" },
    "sender@example.invalid",
    id
  )
  expect(result).toMatchObject({
    text: "Preview",
    untrusted: true,
    headers: [{ name: "Subject", value: "Test" }],
  })
})
it("names draft and message IDs apart so drafts are edited by draft ID", async () => {
  // B2, 8 October: the model edited a draft by the message ID that a draft
  // read returned as its only `id`, which Gmail rejects.
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        id: "r-1",
        message: {
          id: "m-1",
          threadId: "t-1",
          payload: {
            mimeType: "text/plain",
            body: { data: Buffer.from("Borrador").toString("base64url") },
            headers: [{ name: "Subject", value: "Prueba" }],
          },
        },
      })
    )
    .mockResolvedValueOnce(
      Response.json({
        drafts: [{ id: "r-1", message: { id: "m-1", threadId: "t-1" } }],
      })
    )
  vi.stubGlobal("fetch", fetch)
  const read = await gmail(
    "synthetic",
    "gmail.drafts.read",
    { id: "r-1" },
    "sender@example.invalid",
    id
  )
  expect(read).toMatchObject({
    draftId: "r-1",
    messageId: "m-1",
    threadId: "t-1",
    text: "Borrador",
  })
  expect(read).not.toHaveProperty("id")
  expect(
    await gmail(
      "synthetic",
      "gmail.drafts.list",
      { limit: 5 },
      "sender@example.invalid",
      id
    )
  ).toEqual({ drafts: [{ draftId: "r-1", messageId: "m-1", threadId: "t-1" }] })
  for (const operation of [
    "gmail.drafts.read",
    "gmail.drafts.update",
    "gmail.drafts.delete",
  ] as const)
    expect(
      toolParameters({ kind: "gmail", operation }).properties?.id
    ).toMatchObject({ description: expect.stringMatching(/Never a messageId/) })
})
it("proposes a write without accessing Google or exposing credentials", async () => {
  const fetch = vi.fn()
  vi.stubGlobal("fetch", fetch)
  const execute = vi.fn().mockResolvedValue({ pendingApproval: true })
  await executeGmail(
    "gmail.send",
    message,
    { connectionId: id, operations: ["gmail.send"] },
    { id, token: id, kind: "retrieve" },
    execute,
    {
      clientId: "test",
      clientSecret: "test",
      redirectUri: "http://localhost",
      keys: keyring(key),
    }
  )
  expect(fetch).not.toHaveBeenCalled()
  expect(execute.mock.calls[0]![0]).toBe("gmail-propose")
  expect(JSON.stringify(execute.mock.calls)).not.toContain("Texto sintético")
})
it("rechecks authorization before a read and before returning its result", async () => {
  const execute = vi.fn().mockResolvedValue({ ok: true })
  execute.mockResolvedValueOnce({
    credential: seal({ refreshToken: "synthetic" }, `gmail:${id}`, key),
    account: "sender@example.invalid",
  })
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ access_token: "synthetic", expires_in: 3600 })
      )
      .mockResolvedValueOnce(Response.json({ messages: [] }))
  )
  await executeGmail(
    "gmail.search",
    { query: "test", limit: 1 },
    { connectionId: id, operations: ["gmail.search"] },
    { id, token: id, kind: "retrieve" },
    execute,
    {
      clientId: "test",
      clientSecret: "test",
      redirectUri: "http://localhost",
      keys: keyring(key),
    }
  )
  expect(execute.mock.calls.map((c) => c[0])).toEqual([
    "gmail-read",
    "gmail-check",
    "gmail-check",
  ])
})
it("returns five bounded email summaries only with read permission and rechecks every expansion", async () => {
  const execute = vi.fn().mockResolvedValue({ ok: true })
  execute.mockResolvedValueOnce({
    credential: seal({ refreshToken: "synthetic" }, `gmail:${id}`, key),
    account: "sender@example.invalid",
  })
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ access_token: "synthetic", expires_in: 3600 })
    )
    .mockResolvedValueOnce(
      Response.json({
        messages: Array.from({ length: 5 }, (_, i) => ({
          id: `m${i}`,
          threadId: `t${i}`,
        })),
      })
    )
  for (let i = 0; i < 5; i++)
    fetch.mockResolvedValueOnce(
      Response.json({
        id: `m${i}`,
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Subject", value: `Synthetic ${i}` }],
          body: { data: Buffer.from("x".repeat(1000)).toString("base64url") },
        },
      })
    )
  vi.stubGlobal("fetch", fetch)
  const result = await executeGmail(
    "gmail.search",
    { query: "in:inbox", limit: 5 },
    { connectionId: id, operations: ["gmail.search", "gmail.read"] },
    { id, token: id, kind: "retrieve" },
    execute,
    {
      clientId: "test",
      clientSecret: "test",
      redirectUri: "http://localhost",
      keys: keyring(key),
    }
  )
  expect(result).toMatchObject({
    messages: Array.from({ length: 5 }, (_, i) => ({
      id: `m${i}`,
      excerpt: "x".repeat(500),
      untrusted: true,
    })),
  })
  expect(fetch).toHaveBeenCalledTimes(7)
  expect(
    execute.mock.calls.filter(
      (c) => c[0] === "gmail-check" && c[2].operation === "gmail.read"
    )
  ).toHaveLength(10)
})
it("does not expand email content when only search is enabled", async () => {
  const execute = vi.fn().mockResolvedValue({ ok: true })
  execute.mockResolvedValueOnce({
    credential: seal({ refreshToken: "synthetic" }, `gmail:${id}`, key),
    account: "sender@example.invalid",
  })
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({ access_token: "synthetic", expires_in: 3600 })
    )
    .mockResolvedValueOnce(
      Response.json({ messages: [{ id: "m1", threadId: "t1" }] })
    )
  vi.stubGlobal("fetch", fetch)
  expect(
    await executeGmail(
      "gmail.search",
      { query: "in:inbox", limit: 1 },
      { connectionId: id, operations: ["gmail.search"] },
      { id, token: id, kind: "retrieve" },
      execute,
      {
        clientId: "test",
        clientSecret: "test",
        redirectUri: "http://localhost",
        keys: keyring(key),
      }
    )
  ).toEqual({ messages: [{ id: "m1", threadId: "t1" }] })
  expect(fetch).toHaveBeenCalledTimes(2)
})

// §67: a reply draft goes in the thread of the message it answers.
it("puts a reply in the original's thread with reply headers, and leaves other drafts alone", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        id: "orig-1",
        threadId: "thread-1",
        payload: {
          headers: [
            { name: "Message-Id", value: "<abc@mail.example.invalid>" },
            { name: "References", value: "<root@mail.example.invalid>" },
          ],
        },
      })
    )
    .mockResolvedValueOnce(
      Response.json({ id: "r-9", message: { id: "m-9", threadId: "thread-1" } })
    )
    .mockResolvedValueOnce(
      Response.json({ id: "r-10", message: { id: "m-10" } })
    )
  vi.stubGlobal("fetch", fetch)
  await gmail(
    "synthetic",
    "gmail.drafts.create",
    { ...message, subject: "Re: Prueba", replyTo: "orig-1" },
    "sender@example.invalid",
    id
  )
  expect(String(fetch.mock.calls[0]![0])).toContain(
    "messages/orig-1?format=metadata"
  )
  const body = JSON.parse(String(fetch.mock.calls[1]![1].body))
  expect(body.message.threadId).toBe("thread-1")
  const raw = Buffer.from(body.message.raw, "base64url").toString()
  expect(raw).toContain("In-Reply-To: <abc@mail.example.invalid>")
  expect(raw).toContain(
    "References: <root@mail.example.invalid> <abc@mail.example.invalid>"
  )
  // A new conversation (replyTo null) reads nothing and sets no thread.
  await gmail(
    "synthetic",
    "gmail.drafts.create",
    { ...message, replyTo: null },
    "sender@example.invalid",
    id
  )
  expect(fetch).toHaveBeenCalledTimes(3)
  const plain = JSON.parse(String(fetch.mock.calls[2]![1].body))
  expect(plain.message).not.toHaveProperty("threadId")
  expect(Buffer.from(plain.message.raw, "base64url").toString()).not.toContain(
    "In-Reply-To"
  )
})
it("shows batch searches longer excerpts with their thread; earlier runtimes keep 500 characters", async () => {
  const run = async (batch: boolean) => {
    const execute = vi.fn().mockResolvedValue({ ok: true })
    execute.mockResolvedValueOnce({
      credential: seal({ refreshToken: "synthetic" }, `gmail:${id}`, key),
      account: "sender@example.invalid",
    })
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ access_token: "synthetic", expires_in: 3600 })
        )
        .mockResolvedValueOnce(
          Response.json({ messages: [{ id: "m0", threadId: "t0" }] })
        )
        .mockResolvedValueOnce(
          Response.json({
            id: "m0",
            threadId: "t0",
            payload: {
              mimeType: "text/plain",
              body: {
                data: Buffer.from("x".repeat(3000)).toString("base64url"),
              },
            },
          })
        )
    )
    return (await executeGmail(
      "gmail.search",
      { query: "in:inbox", limit: 1 },
      { connectionId: id, operations: ["gmail.search", "gmail.read"] },
      { id, token: id, kind: "retrieve" },
      execute,
      {
        clientId: "test",
        clientSecret: "test",
        redirectUri: "http://localhost",
        keys: keyring(key),
      },
      { batch }
    )) as { messages: { excerpt: string; threadId?: string }[] }
  }
  const batch = (await run(true)).messages[0]!
  expect(batch.excerpt).toHaveLength(2000)
  expect(batch.threadId).toBe("t0")
  const legacy = (await run(false)).messages[0]!
  expect(legacy.excerpt).toHaveLength(500)
  expect(legacy).not.toHaveProperty("threadId")
})
