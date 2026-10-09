import { readdirSync, readFileSync } from "node:fs"
import { expect, it } from "vitest"

// Owner report, 2026-10-09: on a phone the agent page's four tabs were wider
// than the screen, so the whole page widened and Safari zoomed out. A line tab
// row scrolls sideways inside the page instead: the shared TabsBar, or a list
// wrapped in its own overflow-x-auto box.
const dir = "packages/ui/src/components"
const sources = readdirSync(dir)
  .filter((file) => file.endsWith(".tsx") && file !== "tabs.tsx")
  .map((file) => ({ file, text: readFileSync(`${dir}/${file}`, "utf8") }))

it("every line tab row scrolls sideways instead of widening the page", () => {
  for (const { file, text } of sources)
    for (const match of text.matchAll(/<TabsList\b[^>]*variant="line"/g))
      expect(
        text
          .slice(0, match.index)
          .trimEnd()
          .endsWith('<div className="overflow-x-auto">'),
        file
      ).toBe(true)
})

it("both agent pages and the Gmail accounts use the shared TabsBar", () => {
  const bars = sources.filter(({ text }) => text.includes("<TabsBar"))
  expect(bars.map(({ file }) => file).sort()).toEqual(
    expect.arrayContaining([
      "agent-page-tabs.tsx",
      "gmail-connection.tsx",
      "operations-agent.tsx",
    ])
  )
})
