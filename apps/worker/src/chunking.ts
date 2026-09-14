export type PageText = { text: string; page?: number }
export type Chunk = {
  text: string
  locator: { page?: number; section?: string; start: number; end: number }
}
export function chunkPages(pages: PageText[]): Chunk[] {
  const output: Chunk[] = []
  if (pages.reduce((sum, p) => sum + p.text.length, 0) > 2_000_000)
    throw new Error("too_much_text")
  for (const page of pages) {
    const text = page.text.normalize("NFC").replace(/\r\n?/g, "\n")
    let start = 0,
      section: string | undefined
    while (start < text.length) {
      let end = Math.min(start + 2400, text.length)
      if (end < text.length) {
        const boundary = text.lastIndexOf("\n\n", end)
        const word = text.lastIndexOf(" ", end)
        if (boundary > start + 1200) end = boundary
        else if (word > start + 1200) end = word
      }
      const content = text.slice(start, end).trim()
      const headings = [...content.matchAll(/^#{1,6}\s+(.+)$/gm)]
      if (headings.length) section = headings[0]![1]!.slice(0, 180)
      if (content)
        output.push({
          text: content,
          locator: {
            ...(page.page ? { page: page.page } : {}),
            ...(section ? { section } : {}),
            start,
            end,
          },
        })
      if (output.length > 1000) throw new Error("too_much_text")
      if (end === text.length) break
      start = Math.max(start + 1, end - 240)
    }
  }
  if (!output.length) throw new Error("invalid_document")
  return output
}
