import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { pageTitle } from "../packages/ui/src/lib/page-title"
import { navigation as admin } from "../apps/admin/lib/navigation"
import { navigation as customer } from "../apps/customer/lib/navigation"

// Every panel page's breadcrumb reads as a capitalised Spanish title, never a
// raw URL word; record pages keep their short id.
function routes(dir: string, path = ""): string[] {
  const found = readdirSync(dir).includes("page.tsx") ? [path || "/"] : []
  for (const entry of readdirSync(dir)) {
    if (!statSync(join(dir, entry)).isDirectory()) continue
    const segment =
      entry === "[id]" ? "f93ada95-8161-49f6-8179-c6480b6910b2" : entry
    found.push(...routes(join(dir, entry), `${path}/${segment}`))
  }
  return found
}

describe("breadcrumb page titles", () => {
  for (const [app, nav] of [
    ["admin", admin],
    ["customer", customer],
  ] as const) {
    it(`gives every ${app} page a capitalised title`, () => {
      const pages = routes(`apps/${app}/app/(panel)`)
      expect(pages).toContain("/password")
      for (const page of pages) {
        const title =
          nav.find((item) => item.href === page)?.title ?? pageTitle(page)
        if (title === "f93ada95") continue
        expect(title, page).toMatch(/^\p{Lu}/u)
      }
    })
  }

  it("names the approval receipt", () => {
    expect(
      pageTitle("/submissions/f93ada95-8161-49f6-8179-c6480b6910b2/receipt")
    ).toBe("Comprobante")
  })
})
