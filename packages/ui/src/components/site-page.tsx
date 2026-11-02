import Link from "next/link"
import { BotIcon } from "lucide-react"
import { cn } from "cn"
import { buttonVariants } from "@workspace/ui/components/button"
import {
  APP_URL,
  GOOGLE_USER_DATA_POLICY,
  LIMITED_USE_STATEMENT,
  privacyPolicy,
  siteHome,
  siteLabels,
  sitePaths,
  termsOfService,
  type Locale,
  type SiteDocument,
  type SiteSection,
} from "@workspace/ui/lib/site-content"
// The public site (architecture §85): pages anyone can read without signing
// in. Rendered on the server, with no client script of their own.
type Page = "home" | "privacy" | "terms"
function Frame({
  locale,
  page,
  children,
}: {
  locale: Locale
  page: Page
  children: React.ReactNode
}) {
  const labels = siteLabels[locale]
  const other: Locale = locale === "es" ? "en" : "es"
  const paths = sitePaths[locale]
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="border-b">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-6 py-4">
          <Link
            href={paths.home}
            className="flex items-center gap-2 font-semibold"
          >
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <BotIcon className="size-4" />
            </span>
            {labels.brand}
          </Link>
          <nav className="flex items-center gap-3 text-sm">
            <Link
              href={sitePaths[other][page]}
              hrefLang={other}
              lang={other}
              aria-label={labels.otherLanguageLabel}
              className="text-muted-foreground underline-offset-4 hover:underline"
            >
              {labels.otherLanguage}
            </Link>
            <a
              href={`${APP_URL}/login`}
              className={cn(buttonVariants({ size: "sm" }))}
            >
              {labels.signIn}
            </a>
          </nav>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
        {children}
      </main>
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-6 py-6 text-xs text-muted-foreground">
          <span>{labels.operator}</span>
          <nav className="flex gap-4">
            <Link href={paths.home} className="hover:underline">
              {labels.home}
            </Link>
            <Link href={paths.privacy} className="hover:underline">
              {labels.privacy}
            </Link>
            <Link href={paths.terms} className="hover:underline">
              {labels.terms}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
function Section({ section }: { section: SiteSection }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold">{section.heading}</h2>
      {section.paragraphs?.map((text) => (
        <p key={text} className="leading-relaxed">
          {text}
        </p>
      ))}
      {section.bullets && (
        <ul className="list-disc space-y-2 pl-5">
          {section.bullets.map((text) => (
            <li key={text} className="leading-relaxed">
              {text}
            </li>
          ))}
        </ul>
      )}
      {section.after?.map((text) => (
        <p key={text} className="leading-relaxed">
          {text}
        </p>
      ))}
    </section>
  )
}
function LimitedUse({ locale }: { locale: Locale }) {
  return (
    <p className="rounded-lg border bg-muted/40 p-4 text-sm leading-relaxed">
      {LIMITED_USE_STATEMENT[locale]}{" "}
      <a
        href={GOOGLE_USER_DATA_POLICY}
        rel="noopener noreferrer"
        className="underline underline-offset-4"
      >
        {siteLabels[locale].policyLink}
      </a>
    </p>
  )
}
export function SiteHome({ locale }: { locale: Locale }) {
  const home = siteHome[locale]
  return (
    <Frame locale={locale} page="home">
      <article className="space-y-10">
        <div className="space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight">
            {home.title}
          </h1>
          <p className="text-lg leading-relaxed text-muted-foreground">
            {home.lead}
          </p>
        </div>
        {home.sections.map((section) => (
          <Section key={section.heading} section={section} />
        ))}
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{home.limitedUseHeading}</h2>
          <LimitedUse locale={locale} />
        </section>
      </article>
    </Frame>
  )
}
function Document({
  locale,
  page,
  document,
  limitedUse,
}: {
  locale: Locale
  page: Page
  document: SiteDocument
  limitedUse?: boolean
}) {
  return (
    <Frame locale={locale} page={page}>
      <article className="space-y-8">
        <div className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            {document.title}
          </h1>
          <p className="text-sm text-muted-foreground">
            {siteLabels[locale].updated} {document.updated}
          </p>
          {document.intro.map((text) => (
            <p key={text} className="leading-relaxed">
              {text}
            </p>
          ))}
        </div>
        {limitedUse && <LimitedUse locale={locale} />}
        {document.sections.map((section) => (
          <Section key={section.heading} section={section} />
        ))}
      </article>
    </Frame>
  )
}
export function SitePrivacy({ locale }: { locale: Locale }) {
  return (
    <Document
      locale={locale}
      page="privacy"
      document={privacyPolicy[locale]}
      limitedUse
    />
  )
}
export function SiteTerms({ locale }: { locale: Locale }) {
  return (
    <Document locale={locale} page="terms" document={termsOfService[locale]} />
  )
}
