import { runPreviewCommand } from "@agentonic/server/preview"
export async function POST(request: Request) {
  try {
    const origin = request.headers.get("origin")
    if (!origin || new URL(origin).host !== request.headers.get("host"))
      return new Response(null, { status: 403 })
    if (Number(request.headers.get("content-length") ?? 0) > 8192)
      return new Response(null, { status: 413 })
    const reader = request.body?.getReader()
    if (!reader) return new Response(null, { status: 400 })
    let size = 0
    const parts: Uint8Array[] = []
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 8192) {
        await reader.cancel()
        return new Response(null, { status: 413 })
      }
      parts.push(value)
    }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(parts)
    )
    const data = await runPreviewCommand(
      new URL(request.url).searchParams.get("workspace") ?? "",
      JSON.parse(raw)
    )
    return Response.json(data ?? { error: "unavailable" }, {
      status: data ? 200 : 403,
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch {
    return Response.json({ error: "unavailable" }, { status: 400 })
  }
}
