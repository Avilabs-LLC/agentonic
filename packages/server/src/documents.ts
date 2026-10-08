import "server-only"
import { createHash, randomUUID } from "node:crypto"
import { uuid } from "@agentonic/contracts/identity"
import { authClient, requireVerifiedUser } from "./auth"
import { runAuthoringCommand } from "./authoring"
import type { DocumentError } from "@agentonic/contracts/document-errors"
const limit = 10485760
const denied = (status = 400, code: DocumentError = "invalid_file") =>
  Response.json(
    { ok: false, code },
    { status, headers: { "Cache-Control": "private, no-store" } }
  )
type UploadStage =
  | "request"
  | "authenticate"
  | "read_body"
  | "reserve"
  | "storage"
  | "complete"
  | "cleanup"
export async function uploadDocument(
  request: Request,
  stage: (value: UploadStage) => void = () => {}
) {
  const origin = request.headers.get("origin")
  try {
    if (!origin || new URL(origin).host !== request.headers.get("host"))
      return denied(403, "origin_mismatch")
  } catch {
    return denied(403, "origin_mismatch")
  }
  stage("authenticate")
  try {
    await requireVerifiedUser("customer")
  } catch {
    return denied(401, "session_expired")
  }
  const url = new URL(request.url)
  const workspaceId = url.searchParams.get("workspace")
  const collectionId = url.searchParams.get("collection")
  if (
    !uuid.safeParse(workspaceId).success ||
    !uuid.safeParse(collectionId).success
  )
    return denied(400, "collection_required")
  let filename: string
  try {
    filename = decodeURIComponent(
      request.headers.get("x-file-name") ?? ""
    ).normalize("NFC")
  } catch {
    return denied()
  }
  if (
    !filename ||
    filename.length > 200 ||
    Array.from(filename).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
    ) ||
    filename.includes("/") ||
    filename.includes("\\")
  )
    return denied()
  const extension = filename.split(".").pop()?.toLowerCase()
  const contentType =
    extension === "pdf"
      ? "application/pdf"
      : extension === "txt"
        ? "text/plain"
        : extension === "md"
          ? "text/markdown"
          : null
  if (!contentType || !request.body) return denied()
  if (Number(request.headers.get("content-length") ?? 0) > limit)
    return denied(413, "too_large")
  stage("read_body")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      return denied(413, "too_large")
    }
    chunks.push(value)
  }
  if (!size) return denied()
  const bytes = Buffer.concat(chunks)
  if (contentType === "application/pdf") {
    if (bytes.subarray(0, 5).toString() !== "%PDF-") return denied()
  } else {
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      if (text.includes("\0")) return denied()
    } catch {
      return denied()
    }
  }
  stage("reserve")
  const stored = await storeDocument(
    // Both were checked as UUIDs above.
    {
      workspaceId: workspaceId!,
      collectionId: collectionId!,
      filename,
      bytes,
      contentType,
    },
    stage
  )
  return stored.ok
    ? Response.json(
        { ok: true, id: stored.id },
        { headers: { "Cache-Control": "private, no-store" } }
      )
    : denied(stored.code === "access_denied" ? 403 : 409, stored.code)
}
/**
 * Reserves, uploads and completes one document as the signed-in customer: the
 * upload route and an accepted style guide (§57) both store documents this way.
 */
export async function storeDocument(
  document: {
    workspaceId: string
    collectionId: string
    filename: string
    bytes: Buffer
    contentType: "application/pdf" | "text/plain" | "text/markdown"
  },
  stage: (value: UploadStage) => void = () => {}
): Promise<{ ok: true; id: string } | { ok: false; code: DocumentError }> {
  const { workspaceId, collectionId, filename, bytes, contentType } = document
  const reserved = await runAuthoringCommand("customer", {
    workspaceId,
    operation: "upload.reserve",
    payload: {
      collectionId,
      title: filename,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      contentType,
    },
  })
  if (!reserved.ok || !reserved.id) return { ok: false, code: "access_denied" }
  const objectId = reserved.id
  const objectKey = `${workspaceId}/${objectId}`
  let failure: DocumentError = "storage_failed"
  try {
    stage("storage")
    const client = await authClient("customer")
    const uploaded = await client.storage
      .from("agentonic-documents")
      .upload(objectKey, bytes, {
        contentType,
        upsert: false,
        cacheControl: "0",
      })
    if (uploaded.error) throw new Error("Upload failed")
    failure = "completion_failed"
    stage("complete")
    const completed = await runAuthoringCommand("customer", {
      workspaceId,
      operation: "upload.complete",
      payload: { objectId },
    })
    if (!completed.ok) throw new Error("Completion failed")
    return { ok: true, id: objectId }
  } catch {
    stage("cleanup")
    await runAuthoringCommand("customer", {
      workspaceId,
      operation: "upload.fail",
      payload: { objectId },
    })
    return { ok: false, code: failure }
  }
}
export async function downloadDocument(request: Request, objectId: string) {
  const workspaceId = new URL(request.url).searchParams.get("workspace")
  const r = await runAuthoringCommand("customer", {
    workspaceId,
    operation: "document.download",
    payload: { objectId },
  })
  if (!r.ok) return denied(404)
  const data = r.data as {
    objectKey: string
    contentType: string
    title: string
  }
  const client = await authClient("customer")
  const file = await client.storage
    .from("agentonic-documents")
    .download(data.objectKey)
  if (file.error || !file.data) return denied(404)
  return new Response(file.data, {
    headers: {
      "Content-Type": data.contentType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(data.title)}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      // Permit the attachment download without allowing scripts or same-origin content.
      "Content-Security-Policy":
        "sandbox allow-downloads; default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    },
  })
}

// One reference connects client failures to safe server diagnostics. Never log
// file names/bytes, identities, request headers, provider messages or SQL errors.
export async function handleDocumentUpload(request: Request) {
  const reference = randomUUID()
  let stage: UploadStage = "request"
  let response: Response
  try {
    response = await uploadDocument(request, (value) => {
      stage = value
    })
  } catch {
    response = denied(503, "unavailable")
  }
  response.headers.set("X-Upload-Reference", reference)
  if (!response.ok) {
    const result = await response.clone().json()
    console.error(
      JSON.stringify({
        event: "document_upload_failed",
        reference,
        stage,
        status: response.status,
        code: result.code,
      })
    )
  }
  return response
}
