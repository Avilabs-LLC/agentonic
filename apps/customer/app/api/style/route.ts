import { runStyleCommand } from "@agentonic/server/style-guide"

// Aprender mi estilo (architecture §57). An accepted guide carries its reviewed
// text, so this route allows a larger body than /api/gmail.
const LIMIT = 65536
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
      if (size > LIMIT) {
        await reader.cancel()
        return new Response(null, { status: 413 })
      }
      parts.push(value)
    }
    const workspace = new URL(request.url).searchParams.get("workspace") ?? ""
    const result = await runStyleCommand(
      workspace,
      JSON.parse(Buffer.concat(parts).toString())
    )
    return Response.json(result, {
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch {
    return Response.json(
      {
        error:
          "No se pudo completar la acción. Vuelve a cargar la página e inténtalo de nuevo.",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    )
  }
}
