import {
  gmailInvocations,
  confirmGmail,
  cancelGmail,
  gmailPermissions,
  disconnectGmail,
} from "@agentonic/server/gmail"
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
      if (size > 8192) {
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
    let result: unknown
    if (data.operation === "list")
      result = {
        items: await gmailInvocations(
          workspace,
          String(p.conversationId),
          p.context === "preview" ? "preview" : "staging"
        ),
      }
    else if (data.operation === "confirm")
      result = await confirmGmail(workspace, String(p.id), String(p.hash))
    else if (data.operation === "cancel")
      result = await cancelGmail(workspace, String(p.id))
    else if (data.operation === "permissions") {
      await gmailPermissions(
        workspace,
        String(p.agentId),
        String(p.connectionId),
        p.operations
      )
      result = { ok: true }
    } else if (data.operation === "disconnect")
      result = await disconnectGmail(workspace, String(p.connectionId))
    else return new Response(null, { status: 400 })
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
