// Isolated child: bounded heap/lifetime, no filesystem output, no provider access.
import process from "node:process"
import { Buffer } from "node:buffer"
import { PDFParse } from "pdf-parse"
let processing = false
function send(result) {
  return new Promise((resolve, reject) => {
    process.send(result, (error) => (error ? reject(error) : resolve()))
  })
}
process.on("message", async ({ data }) => {
  if (processing) return
  processing = true
  // Keep the message listener alive through asynchronous font loading and IPC delivery.
  let parser
  try {
    parser = new PDFParse({ data: new Uint8Array(Buffer.from(data, "base64")) })
    const info = await parser.getInfo()
    if (info.total > 200) throw new Error("too_much_text")
    const extracted = await parser.getText()
    const pages = extracted.pages.map((p) => ({ page: p.num, text: p.text }))
    if (pages.reduce((n, p) => n + p.text.length, 0) > 2_000_000)
      throw new Error("too_much_text")
    if (!pages.some((p) => p.text.trim().length > 10))
      throw new Error("ocr_required")
    await send({ pages })
  } catch (error) {
    await send({
      error: ["too_much_text", "ocr_required"].includes(error.message)
        ? error.message
        : "invalid_document",
    })
  } finally {
    await parser?.destroy()
    process.disconnect()
  }
})
