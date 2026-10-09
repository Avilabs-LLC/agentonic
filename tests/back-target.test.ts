import { describe, expect, it } from "vitest"
import {
  backTarget,
  type HistoryNavigation,
} from "../packages/ui/src/lib/back-target"

// "Volver atrás" returns to the previous page inside the app; with none behind
// it, the button keeps its link one route level up (UI contract §7).
const origin = "https://admin.example.invalid"
function history(paths: string[], current = paths.length - 1) {
  const entries = paths.map((path, index) => ({
    key: `k${index}`,
    index,
    url: `${origin}${path}`,
  }))
  return {
    currentEntry: entries[current] ?? null,
    entries: () => entries,
    traverseTo: () => ({
      committed: Promise.resolve(),
      finished: Promise.resolve(),
    }),
  } satisfies HistoryNavigation
}

describe("Volver atrás", () => {
  it("falls back to its link without the Navigation API or a page behind", () => {
    expect(backTarget(undefined)).toBeNull()
    expect(
      backTarget(history(["/submissions/a/receipt?workspace=w"]))
    ).toBeNull()
  })

  it("returns to the page the person came from, with its filters", () => {
    const nav = history([
      "/expirations",
      "/submissions?workspace=w&state=approved",
      "/agents/a",
    ])
    expect(backTarget(nav)).toBe("k1")
    expect(
      backTarget(history(["/expirations", "/submissions/a/receipt"]))
    ).toBe("k0")
  })

  it("skips earlier entries of the same page, such as its tabs", () => {
    const nav = history([
      "/agents",
      "/agents/a?workspace=w",
      "/agents/a?workspace=w&tab=propuestas",
    ])
    expect(backTarget(nav)).toBe("k0")
    expect(backTarget(history(["/agents/a", "/agents/a?tab=x"]))).toBeNull()
  })

  it("counts from the current entry after going back", () => {
    const nav = history(
      ["/expirations", "/submissions/a/receipt", "/agents/b"],
      1
    )
    expect(backTarget(nav)).toBe("k0")
  })
})
