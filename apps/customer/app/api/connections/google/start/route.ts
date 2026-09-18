import { startGmail } from "@agentonic/server/gmail"
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin")
    if (!origin || new URL(origin).host !== request.headers.get("host"))
      return new Response(null, { status: 403 })
    const url = new URL(request.url)
    return Response.redirect(
      await startGmail(
        url.searchParams.get("workspace") ?? "",
        url.searchParams.get("agent") ?? ""
      ),
      303
    )
  } catch {
    return new Response(
      "No se pudo iniciar la conexión. Regresa al agente e inténtalo de nuevo.",
      { status: 400, headers: { "Cache-Control": "no-store" } }
    )
  }
}
