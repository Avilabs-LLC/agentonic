import Browserbase from "@browserbasehq/sdk"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { z } from "zod"

export type WebFailureCode =
  | "blocked"
  | "dns_failed"
  | "redirect"
  | "page_http_error"
  | "unsupported_content"
  | "empty_content"
  | "rate_limit"
  | "provider_http_error"
  | "provider_timeout"
  | "provider_unavailable"
  | "invalid_response"
export class WebError extends Error {
  constructor(
    public code: WebFailureCode,
    public status?: number
  ) {
    super("provider_unavailable")
  }
}
export function classifyWebError(error: unknown): WebError {
  if (error instanceof WebError) return error
  if (error instanceof z.ZodError) return new WebError("invalid_response")
  if (
    error instanceof Browserbase.APIConnectionTimeoutError ||
    (error instanceof Error &&
      ["TimeoutError", "AbortError"].includes(error.name))
  )
    return new WebError("provider_timeout")
  if (error instanceof Browserbase.APIError) {
    const status = error.status
    return new WebError(
      status === 429 ? "rate_limit" : "provider_http_error",
      status
    )
  }
  return new WebError("provider_unavailable")
}
// Only public HTTPS names; no custom ports, credentials, fragments, IP literals,
// localhost aliases, private DNS answers, or automatic redirect following.
export function publicWebUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new WebError("blocked")
  }
  const host = url.hostname.toLowerCase()
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    host.endsWith(".") ||
    isIP(host) ||
    host.includes(":") ||
    !host.includes(".") ||
    /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host) ||
    host.endsWith(".nip.io") ||
    host.endsWith(".sslip.io") ||
    value.length > 2048
  )
    throw new WebError("blocked")
  url.hash = ""
  return url.toString()
}
export function publicAddress(address: string) {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number)
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    )
  }
  // Global unicast only, excluding documentation and transition ranges.
  return (
    isIP(address) === 6 &&
    /^[23][0-9a-f]{3}:/i.test(address) &&
    !/^(2001:(0:|db8:|[12][0-9a-f]:)|2002:)/i.test(address)
  )
}
export async function verifyPublicWebUrl(value: string) {
  const url = publicWebUrl(value)
  const addresses = await lookup(new URL(url).hostname, {
    all: true,
    verbatim: true,
  }).catch(() => {
    throw new WebError("dns_failed")
  })
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw new WebError("blocked")
  return url
}
export function browserbaseClient(apiKey: string) {
  if (!apiKey) throw new Error("configuration_required")
  return new Browserbase({
    apiKey,
    maxRetries: 0,
    timeout: 20000,
    fetch: globalThis.fetch,
  })
}
export async function searchWeb(
  client: Browserbase,
  query: string,
  signal: AbortSignal
) {
  const response = await client.search.web({ query, numResults: 5 }, { signal })
  const parsed = z
    .object({
      results: z
        .array(z.object({ title: z.string(), url: z.string() }))
        .max(25),
    })
    .parse(response)
  return parsed.results
    .flatMap((r) => {
      try {
        return [{ title: r.title.slice(0, 250), url: publicWebUrl(r.url) }]
      } catch {
        return []
      }
    })
    .slice(0, 5)
}
export async function readWeb(
  client: Browserbase,
  url: string,
  signal: AbortSignal
) {
  const response = await client.fetchAPI.create(
    {
      url,
      format: "markdown",
      allowRedirects: false,
      allowInsecureSsl: false,
      proxies: false,
    },
    { signal }
  )
  if (
    !Number.isInteger(response.statusCode) ||
    response.statusCode < 100 ||
    response.statusCode > 599
  )
    throw new WebError("invalid_response")
  if (response.statusCode >= 300 && response.statusCode < 400)
    throw new WebError("redirect", response.statusCode)
  if (response.statusCode < 200 || response.statusCode >= 300)
    throw new WebError(
      response.statusCode === 429 ? "rate_limit" : "page_http_error",
      response.statusCode
    )
  if (
    typeof response.content !== "string" ||
    typeof response.contentType !== "string"
  )
    throw new WebError("invalid_response")
  if (
    !/^(text\/(html|plain|markdown)|application\/xhtml\+xml)(;|$)/i.test(
      response.contentType
    )
  )
    throw new WebError("unsupported_content")
  if (!response.content.trim()) throw new WebError("empty_content")
  return {
    url,
    text: response.content.slice(0, 16000),
    truncated: response.content.length > 16000,
  }
}
