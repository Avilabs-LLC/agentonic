import { readdirSync, readFileSync } from "node:fs"
import { expect, it } from "vitest"

// Owner direction, 2026-10-08 (reported twice): actions menus size to their
// longest label and never wrap. Every DropdownMenuContent uses the shared class.
const dir = "packages/ui/src/components"
// The account menu opens from the full-width sidebar button, never an icon.
const exempt = new Set(["dropdown-menu.tsx", "app-shell.tsx"])

it("every actions menu sizes to its labels instead of wrapping them", () => {
  const menus = readdirSync(dir)
    .filter((file) => file.endsWith(".tsx") && !exempt.has(file))
    .flatMap((file) =>
      [
        ...readFileSync(`${dir}/${file}`, "utf8").matchAll(
          /<DropdownMenuContent\b[^>]*>/g
        ),
      ].map((match) => ({ file, tag: match[0] }))
    )
  expect(menus.length).toBeGreaterThanOrEqual(5)
  for (const menu of menus)
    expect(menu.tag, menu.file).toContain("className={actionsMenuClassName}")
})
