import { describe, expect, it } from "vitest"
import { SITE_HOSTNAME } from "../packages/contracts/src/site"
import {
  LIMITED_USE_STATEMENT,
  privacyPolicy,
  sitePaths,
  termsOfService,
} from "../packages/ui/src/lib/site-content"

// The public site (architecture §85): the homepage, privacy policy and terms
// Google's OAuth reviewers read, in Spanish and English, rendered on the
// server without signing in.
const load = (path: string) =>
  import(/* @vite-ignore */ path) as Promise<Record<string, unknown>>
type Component = (props: Record<string, unknown>) => unknown
const react = await load("../packages/ui/node_modules/react/index.js")
const server = await load(
  "../packages/ui/node_modules/react-dom/server.node.js"
)
const { SiteHome, SitePrivacy, SiteTerms } = (await load(
  "../packages/ui/src/components/site-page"
)) as { SiteHome: Component; SitePrivacy: Component; SiteTerms: Component }
const hosted = (await load("../scripts/platform-units.mjs")) as {
  siteHostname: string
  caddyfile: (options?: { site?: boolean }) => string
}
/** The statement as React writes it into HTML (apostrophes escaped). */
const limitedUse = (locale: "es" | "en") =>
  LIMITED_USE_STATEMENT[locale].replace(/'/g, "&#x27;")
const render = (component: Component, props: Record<string, unknown>) =>
  (server.renderToStaticMarkup as (node: unknown) => string)(
    (react.createElement as (c: Component, p: unknown) => unknown)(
      component,
      props
    )
  )

describe("the public site", () => {
  it("is proxied by Caddy to the customer app once its name resolves", () => {
    expect(hosted.siteHostname).toBe(SITE_HOSTNAME)
    expect(hosted.caddyfile()).toContain(
      `${SITE_HOSTNAME} {\n\tencode zstd gzip\n\trequest_body {\n\t\tmax_size 1MB\n\t}\n\theader -Server\n\t@root path /\n\trewrite @root /sitio\n\t@en path /en\n\trewrite @en /sitio/en\n\treverse_proxy 127.0.0.1:3101\n}`
    )
    expect(hosted.caddyfile({ site: false })).not.toContain(
      `\n${SITE_HOSTNAME} {`
    )
  })

  for (const locale of ["es", "en"] as const) {
    const other = locale === "es" ? "en" : "es"
    it(`renders the ${locale} homepage with Google's Limited Use statement`, () => {
      const html = render(SiteHome, { locale })
      expect(html).toContain(limitedUse(locale))
      expect(html).toContain("gmail.modify")
      expect(html).toContain("drive.file")
      expect(html).toContain('href="https://app.agentonic.avilabs.tech/login"')
      expect(html).toContain(`href="${sitePaths[other].home}"`)
      expect(html).toContain(`href="${sitePaths[locale].privacy}"`)
      expect(html).toContain(`href="${sitePaths[locale].terms}"`)
      expect(html).not.toContain("<script")
    })

    it(`renders the ${locale} privacy policy with every disclosure Google asks for`, () => {
      const html = render(SitePrivacy, { locale })
      expect(html).toContain(limitedUse(locale))
      expect(html).toContain(
        "https://developers.google.com/terms/api-services-user-data-policy"
      )
      for (const section of privacyPolicy[locale].sections)
        expect(html).toContain(section.heading)
      // Access, use, transfer, protection, retention and deletion, and no training.
      expect(privacyPolicy[locale].sections.map((s) => s.heading)).toEqual([
        expect.stringMatching(/^1\./),
        expect.stringMatching(/Google/),
        expect.stringMatching(/^3\./),
        expect.stringMatching(/^4\./),
        expect.stringMatching(/^5\. (Sin entrenamiento|No AI model training)/),
        expect.stringMatching(/^6\./),
        expect.stringMatching(/^7\./),
        expect.stringMatching(/^8\./),
        expect.stringMatching(/^9\./),
      ])
      expect(html).toContain("https://www.googleapis.com/auth/gmail.modify")
      expect(html).toContain("https://www.googleapis.com/auth/drive.file")
      expect(html).toContain("OpenAI")
      expect(html).toContain("leonardo@avilabs.tech")
      expect(html).toContain(`href="${sitePaths[other].privacy}"`)
    })

    it(`renders the ${locale} terms`, () => {
      const html = render(SiteTerms, { locale })
      expect(html).toContain(termsOfService[locale].title)
      for (const section of termsOfService[locale].sections)
        expect(html).toContain(section.heading)
      expect(html).toContain(`href="${sitePaths[other].terms}"`)
    })
  }
})
