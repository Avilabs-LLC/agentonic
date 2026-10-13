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
    // Drive connects for an agent's tools or for the member's knowledge imports;
    // with pick, Google's own consent page also chooses files for a connection.
    const purpose = url.searchParams.get("purpose")
    const connection = url.searchParams.get("connection")
    const collection = url.searchParams.get("collection")
    const target =
      url.searchParams.get("provider") === "drive"
        ? await startDrive(
            workspace,
            purpose === "knowledge" ? "knowledge" : "tools",
            agent || undefined,
            url.searchParams.get("pick") === "1" && connection
              ? {
                  connectionId: connection,
                  ...(collection ? { collectionId: collection } : {}),
                }
              : undefined
          )
        : await startGmail(workspace, agent, connection || undefined)
    return Response.redirect(target, 303)
  } catch {
    return new Response(
      "No se pudo iniciar la conexión. Regresa a la página anterior e inténtalo de nuevo.",
      { status: 400, headers: { "Cache-Control": "no-store" } }
    )
  }
}
