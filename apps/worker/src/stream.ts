// Answers that appear as they are written (architecture §68). The model writes
// its answer as JSON, `{"text":"…","citations":…}`; while it streams, the text
// written so far is decoded from that prefix and shown to the person. The
// recorded answer still comes only from the complete, checked response.

/** The answer text in a JSON prefix such as `{"text":"Hola\n`, or undefined. */
export function partialAnswerText(json: string): string | undefined {
  const start = /^\s*\{\s*"text"\s*:\s*"/.exec(json)
  if (!start) return undefined
  let out = ""
  for (let i = start[0].length; i < json.length; i++) {
    const ch = json[i]!
    if (ch === '"') return out
    if (ch !== "\\") {
      out += ch
      continue
    }
    const next = json[i + 1]
    // An escape cut by the end of the prefix waits for the next delta.
    if (next === undefined) return out
    if (next === "u") {
      const hex = json.slice(i + 2, i + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out
      out += String.fromCharCode(parseInt(hex, 16))
      i += 5
      continue
    }
    out +=
      {
        n: "\n",
        r: "\r",
        t: "\t",
        b: "\b",
        f: "\f",
        '"': '"',
        "\\": "\\",
        "/": "/",
      }[next] ?? ""
    i++
  }
  return out
}

type StreamEvent = { type?: string; delta?: unknown; response?: unknown }

/**
 * Reads an OpenAI Responses event stream. Each message delta goes to
 * `onText` with the message text so far; the result is the final response
 * object, or undefined when the stream ended without one.
 */
export async function readResponseStream(
  body: ReadableStream<Uint8Array>,
  onText: (text: string) => void
): Promise<Record<string, unknown> | undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = "",
    text = "",
    final: Record<string, unknown> | undefined
  const handle = (block: string) => {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (!data || data === "[DONE]") return
    let event: StreamEvent
    try {
      event = JSON.parse(data) as StreamEvent
    } catch {
      return
    }
    if (
      event.type === "response.output_text.delta" &&
      typeof event.delta === "string"
    ) {
      text += event.delta
      onText(text)
    } else if (
      (event.type === "response.completed" ||
        event.type === "response.incomplete") &&
      typeof event.response === "object" &&
      event.response !== null
    )
      final = event.response as Record<string, unknown>
    else if (event.type === "response.failed" || event.type === "error")
      throw new Error("provider_unavailable")
  }
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
    let end: number
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      handle(buffer.slice(0, end))
      buffer = buffer.slice(end + 2)
    }
  }
  if (buffer.trim()) handle(buffer)
  return final
}
