import type { Metadata } from "next"
import { headers } from "next/headers"
import { nonceOf } from "@agentonic/server/security"
import { Figtree } from "next/font/google"
import "@workspace/ui/globals.css"
import { Providers } from "@workspace/ui/components/providers"
const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree" })
export const metadata: Metadata = {
  title: { default: "Agentonic · Administración", template: "%s · Agentonic" },
  description: "Administración de agentes y operaciones.",
  robots: { index: false, follow: false },
}
export default async function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  // The theme script runs before hydration, so it carries the page nonce.
  const nonce = nonceOf((await headers()).get("content-security-policy"))
  return (
    <html lang="es-VE" suppressHydrationWarning className={figtree.variable}>
      {/* Browser extensions can inject body attributes before hydration. */}
      <body suppressHydrationWarning className="font-sans antialiased">
        <Providers nonce={nonce}>{children}</Providers>
      </body>
    </html>
  )
}
