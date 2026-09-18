import { describe, expect, it, vi } from "vitest"
import { formatUtcDateTime } from "../packages/contracts/src/format"

describe("hydration-safe UTC timestamps", () => {
  it("renders the reported expiry identically without engine locale formatting", () => {
    const locale = vi
      .spyOn(Date.prototype, "toLocaleString")
      .mockImplementation(() => {
        throw new Error("Engine-dependent locale output must not be used")
      })
    try {
      const text = formatUtcDateTime("2026-09-16T18:03:59.000Z")
      expect(text).toBe("16/9/2026, 6:03:59 p. m.")
      expect(text).not.toMatch(/[\u00a0\u202f]/)
    } finally {
      locale.mockRestore()
    }
  })
  it.each([
    ["2026-09-16T00:00:00Z", "16/9/2026, 12:00:00 a. m."],
    ["2026-09-16T12:00:00Z", "16/9/2026, 12:00:00 p. m."],
    ["2026-09-16T23:05:09-04:00", "17/9/2026, 3:05:09 a. m."],
    ["2026-01-01T00:05:00+01:00", "31/12/2025, 11:05:00 p. m."],
  ])(
    "formats %s with an explicit UTC date and day period",
    (input, expected) => {
      expect(formatUtcDateTime(input)).toBe(expected)
      expect(formatUtcDateTime(new Date(input))).toBe(expected)
    }
  )
  it("handles invalid dates without rendering Invalid Date", () => {
    expect(formatUtcDateTime("invalid")).toBe("No disponible")
  })
})
