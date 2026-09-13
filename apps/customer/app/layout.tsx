import type { Metadata } from "next"
import { Figtree } from "next/font/google"
import "@workspace/ui/globals.css"
import { Providers } from "@workspace/ui/components/providers"
const figtree = Figtree({ subsets: ["latin"], variable: "--font-figtree" })
export const metadata: Metadata = {
  title: { default: "Agentonic · Mi espacio", template: "%s · Agentonic" },
  description: "Tu espacio para personalizar y trabajar con agentes.",
  robots: { index: false, follow: false },
}
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es-VE" suppressHydrationWarning className={figtree.variable}>
      {/* Browser extensions can inject body attributes before hydration. */}
      <body suppressHydrationWarning className="font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
