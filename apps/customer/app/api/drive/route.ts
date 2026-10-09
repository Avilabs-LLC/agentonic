import {
  addDriveFiles,
  cancelDrive,
  confirmDrive,
  disconnectDrive,
  driveCurrent,
  driveInvocations,
  driveKnowledgeAction,
  drivePermissions,
  drivePicker,
  importDriveKnowledge,
  removeDriveFile,
} from "@agentonic/server/drive"
// Google Drive actions from the customer app (architecture §62). Same-origin
// POSTs only; the server checks the member, workspace and agent every time.
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin")
    if (!origin || new URL(origin).host !== request.headers.get("host"))
      return new Response(null, { status: 403 })
    const reader = request.body?.getReader()
    if (!reader) return new Response(null, { status: 400 })
    const parts: Uint8Array[] = []
    let size = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 16384) {
        await reader.cancel()
        return new Response(null, { status: 413 })
      }
      parts.push(value)
    }
    const data = JSON.parse(Buffer.concat(parts).toString()) as {
        operation: string
        payload: Record<string, unknown>
      },
      p = data.payload
    const workspace = new URL(request.url).searchParams.get("workspace") ?? ""
    const s = (v: unknown) => String(v ?? "")
    let result: unknown
    switch (data.operation) {
      case "list":
        result = {
          items: await driveInvocations(
            workspace,
            s(p.conversationId),
            p.context === "preview" ? "preview" : "staging"
          ),
        }
        break
      case "current":
        result = await driveCurrent(workspace, s(p.id), s(p.hash))
        break
      case "confirm":
        result = await confirmDrive(workspace, s(p.id), s(p.hash))
        break
      case "cancel":
        result = await cancelDrive(workspace, s(p.id))
        break
      case "permissions":
        result = await drivePermissions(
          workspace,
          s(p.agentId),
          s(p.connectionId),
          p.operations
        )
        break
      case "disconnect":
        result = await disconnectDrive(workspace, s(p.connectionId))
        break
      case "picker":
        result = await drivePicker(workspace, s(p.connectionId))
        break
      case "files.add":
        result = await addDriveFiles(
          workspace,
          s(p.agentId),
          s(p.connectionId),
          p.fileIds
        )
        break
      case "files.remove":
        result = await removeDriveFile(
          workspace,
          s(p.agentId),
          s(p.connectionId),
          p.fileId
        )
        break
      case "knowledge.add":
        result = await importDriveKnowledge(
          workspace,
          s(p.connectionId),
          s(p.collectionId),
          p.fileIds
        )
        break
      case "knowledge.sync":
      case "knowledge.apply":
      case "knowledge.remove":
        result = await driveKnowledgeAction(
          workspace,
          data.operation,
          s(p.sourceId)
        )
        break
      default:
        return new Response(null, { status: 400 })
    }
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch {
    return Response.json(
      {
        error:
          "No se pudo completar la acción. Revisa tus permisos y vuelve a cargar el estado antes de intentarlo de nuevo.",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    )
  }
}
