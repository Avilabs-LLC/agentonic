import { runScheduleCommand } from "@agentonic/server/schedules"

// Scheduled jobs (architecture §58).
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
    const workspace = new URL(request.url).searchParams.get("workspace") ?? ""
    const result = await runScheduleCommand(
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
          "No se pudo completar la acción. Revisa los datos de la programación e inténtalo de nuevo.",
      },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    )
  }
}
