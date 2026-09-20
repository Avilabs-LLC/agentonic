import { expect, it } from "vitest"
import { customerDevOrigins } from "../apps/customer/dev-origin"

async function configuration(mode: string, origin?: string) {
  return customerDevOrigins(mode, origin)
}

it("opts in only to the configured tunnel and rewritten local action origins", async () => {
  const config = await configuration(
    "development",
    "https://mobile.example.test:8443"
  )
  expect(config.allowedDevOrigins).toEqual(["mobile.example.test"])
  expect(config.experimental?.serverActions).toEqual({
    allowedOrigins: [
      "mobile.example.test:8443",
      "localhost:3101",
      "127.0.0.1:3101",
    ],
  })
})

it("keeps the default same-origin policy without a configured tunnel", async () => {
  const config = await configuration("development")
  expect(config.allowedDevOrigins).toBeUndefined()
  expect(config.experimental?.serverActions).toBeUndefined()
})

it("never carries development exceptions into production", async () => {
  const config = await configuration("production", "https://mobile.example.test")
  expect(config.allowedDevOrigins).toBeUndefined()
  expect(config.experimental?.serverActions).toBeUndefined()
})

it.each([
  "https://*.example.test",
  "http://mobile.example.test",
  "https://user:password@mobile.example.test",
  "https://mobile.example.test/path",
  "https://mobile.example.test?query=1",
  "https://mobile.example.test#fragment",
  "not a URL",
])("rejects an unsafe or ambiguous development origin: %s", async (origin) => {
  await expect(configuration("development", origin)).rejects.toThrow()
})
