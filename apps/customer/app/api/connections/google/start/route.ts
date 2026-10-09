import { startGmail } from "@agentonic/server/gmail"
import { startDrive } from "@agentonic/server/drive"
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin")
    if (!origin || new URL(origin).host !== request.headers.get("host"))
      return new Response(null, { status: 403 })
    const url = new URL(request.url)
    const workspace = url.searchParams.get("workspace") ?? ""
    const agent = url.searchParams.get("agent") ?? ""
    // Drive connects for an agent's tools or for the member's knowledge imports.
    const purpose = url.searchParams.get("purpose")
    const target =
      url.searchParams.get("provider") === "drive"
        ? await startDrive(
            workspace,
            purpose === "knowledge" ? "knowledge" : "tools",
            agent || undefined
          )
        : await startGmail(workspace, agent)
    return Response.redirect(target, 303)
  } catch {
    return new Response(
      "No se pudo iniciar la conexión. Regresa a la página anterior e inténtalo de nuevo.",
      { status: 400, headers: { "Cache-Control": "no-store" } }
    )
  }
}
