import { beforeEach, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
const mocks = vi.hoisted(() => ({
  verified: vi.fn(),
  command: vi.fn(),
  upload: vi.fn(),
  download: vi.fn(),
}))
vi.mock("../packages/server/src/auth", () => ({
  requireVerifiedUser: mocks.verified,
  authClient: async () => ({
    storage: {
      from: () => ({ upload: mocks.upload, download: mocks.download }),
    },
  }),
}))
vi.mock("../packages/server/src/authoring", () => ({
  runAuthoringCommand: mocks.command,
}))
import {
  uploadDocument,
  handleDocumentUpload,
  downloadDocument,
} from "../packages/server/src/documents"
const workspace = "00000000-0000-4000-8000-000000000101",
  collection = "00000000-0000-4000-8000-000000000102",
  object = "00000000-0000-4000-8000-000000000103"
const request = (
  body: string | Uint8Array = "hello",
  name = "fixture.txt",
  headers: Record<string, string> = {}
) =>
  new Request(
    `http://localhost:3101/api/documents?workspace=${workspace}&collection=${collection}`,
    {
      method: "POST",
      headers: {
        origin: "http://localhost:3101",
        host: "localhost:3101",
        "x-file-name": encodeURIComponent(name),
        ...headers,
      },
      body: body as BodyInit,
    }
  )
beforeEach(() => {
  vi.resetAllMocks()
  mocks.verified.mockResolvedValue({ authId: object })
  mocks.command.mockImplementation(async (_app, input) => ({
    ok: true,
    id: input.operation === "upload.reserve" ? object : null,
    data: null,
  }))
  mocks.upload.mockResolvedValue({ error: null })
})
it("rejects foreign origins before reading content or reserving objects", async () => {
  expect(
    (
      await uploadDocument(
        request("hello", "fixture.txt", { origin: "https://example.invalid" })
      )
    ).status
  ).toBe(403)
  expect(mocks.verified).not.toHaveBeenCalled()
  expect(mocks.command).not.toHaveBeenCalled()
})
it("requires a verified session before any reservation", async () => {
  mocks.verified.mockRejectedValue(new Error("Sign in required"))
  const response = await uploadDocument(request())
  expect(response.status).toBe(401)
  expect(await response.json()).toEqual({ ok: false, code: "session_expired" })
  expect(mocks.command).not.toHaveBeenCalled()
})
it("rejects unsafe filenames, disguised PDFs and invalid text before Storage writes", async () => {
  for (const [body, name] of [
    ["hello", "../fixture.txt"],
    ["hello", "fixture.exe"],
    ["not a PDF", "fixture.pdf"],
    ["bad\u0000text", "fixture.md"],
  ])
    expect(
      (await uploadDocument(request(body, name))).status
    ).toBeGreaterThanOrEqual(400)
  expect(
    (await uploadDocument(request(new Uint8Array([255, 254]), "fixture.txt")))
      .status
  ).toBe(400)
  expect(mocks.command).not.toHaveBeenCalled()
  expect(mocks.upload).not.toHaveBeenCalled()
})
it("enforces actual streamed size even without a Content-Length header", async () => {
  expect((await uploadDocument(request("x".repeat(10485761)))).status).toBe(413)
  expect(mocks.command).not.toHaveBeenCalled()
})
it("hashes actual bytes and uploads once using the reserved private path", async () => {
  expect((await uploadDocument(request())).status).toBe(200)
  expect(mocks.command).toHaveBeenCalledWith(
    "customer",
    expect.objectContaining({
      operation: "upload.reserve",
      payload: expect.objectContaining({
        sha256: createHash("sha256").update("hello").digest("hex"),
        size: 5,
        contentType: "text/plain",
      }),
    })
  )
  expect(mocks.upload).toHaveBeenCalledWith(
    `${workspace}/${object}`,
    Buffer.from("hello"),
    { contentType: "text/plain", upsert: false, cacheControl: "0" }
  )
  expect(mocks.command).toHaveBeenLastCalledWith("customer", {
    workspaceId: workspace,
    operation: "upload.complete",
    payload: { objectId: object },
  })
})
it("marks a failed Storage upload unusable without claiming success", async () => {
  mocks.upload.mockResolvedValue({
    error: { message: "private provider error" },
  })
  const response = await uploadDocument(request())
  expect(response.status).toBe(409)
  expect(await response.text()).not.toContain("private provider error")
  expect(mocks.command).toHaveBeenLastCalledWith("customer", {
    workspaceId: workspace,
    operation: "upload.fail",
    payload: { objectId: object },
  })
})
it("denied download never reaches Storage", async () => {
  mocks.command.mockResolvedValue({ ok: false })
  expect(
    (
      await downloadDocument(
        new Request(
          `http://localhost:3101/api/documents/${object}?workspace=${workspace}`
        ),
        object
      )
    ).status
  ).toBe(404)
  expect(mocks.download).not.toHaveBeenCalled()
})

it("explains a missing collection without reserving or uploading", async () => {
  const req = request()
  const response = await uploadDocument(
    new Request(req.url.replace(/collection=[^&]+/, "collection="), req)
  )
  expect(await response.json()).toEqual({
    ok: false,
    code: "collection_required",
  })
  expect(mocks.command).not.toHaveBeenCalled()
  expect(mocks.upload).not.toHaveBeenCalled()
})
it("rejects malformed filename encoding as an invalid file", async () => {
  const response = await uploadDocument(
    request("hello", "fixture.txt", { "x-file-name": "%ZZ" })
  )
  expect(response.status).toBe(400)
  expect(await response.json()).toEqual({ ok: false, code: "invalid_file" })
  expect(mocks.command).not.toHaveBeenCalled()
})
it("distinguishes Storage failure from completion failure without exposing internals", async () => {
  mocks.upload.mockResolvedValueOnce({ error: { message: "private error" } })
  expect(await (await uploadDocument(request())).json()).toEqual({
    ok: false,
    code: "storage_failed",
  })
  mocks.command.mockImplementation(async (_app, input) => ({
    ok: input.operation !== "upload.complete",
    id: object,
  }))
  expect(await (await uploadDocument(request())).json()).toEqual({
    ok: false,
    code: "completion_failed",
  })
})

it("accepts a 138 KB binary PDF without decoding it as text", async () => {
  const pdf = Buffer.alloc(138 * 1024, 255)
  pdf.write("%PDF-1.7\n")
  const response = await uploadDocument(request(pdf, "fixture.pdf"))
  expect(response.status).toBe(200)
  expect(mocks.upload).toHaveBeenCalledWith(
    `${workspace}/${object}`,
    pdf,
    expect.objectContaining({ contentType: "application/pdf" })
  )
})
it("correlates interrupted body failures without logging private error details", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    const req = request()
    vi.spyOn(req.body!, "getReader").mockImplementation(() => {
      throw new Error("private document content")
    })
    const response = await handleDocumentUpload(req)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ok: false, code: "unavailable" })
    expect(log).toHaveBeenCalledOnce()
    const logged = JSON.parse(log.mock.calls[0]![0])
    expect(logged.stage).toBe("read_body")
    expect(logged.reference).toBe(response.headers.get("X-Upload-Reference"))
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "private document content"
    )
    expect(mocks.command).not.toHaveBeenCalled()
  } finally {
    log.mockRestore()
  }
})

it("returns private download bytes with attachment headers and a download-capable sandbox", async () => {
  const pdf = new Blob(["%PDF-1.7\nsynthetic fixture"], {
    type: "application/pdf",
  })
  mocks.command.mockResolvedValue({
    ok: true,
    data: {
      objectKey: `${workspace}/${object}`,
      contentType: "application/pdf",
      title: "Prueba de descarga.pdf",
    },
  })
  mocks.download.mockResolvedValue({ data: pdf, error: null })
  const response = await downloadDocument(
    new Request(
      `http://localhost:3101/api/documents/${object}?workspace=${workspace}`
    ),
    object
  )
  expect(response.status).toBe(200)
  expect(await response.arrayBuffer()).toEqual(await pdf.arrayBuffer())
  expect(response.headers.get("Content-Disposition")).toBe(
    "attachment; filename*=UTF-8''Prueba%20de%20descarga.pdf"
  )
  expect(response.headers.get("Cache-Control")).toBe("private, no-store")
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff")
  const csp = response.headers.get("Content-Security-Policy")!
  expect(csp).toContain("sandbox allow-downloads")
  expect(csp).toContain("default-src 'none'")
  expect(csp).not.toMatch(/allow-scripts|allow-same-origin/)
})
