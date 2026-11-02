import type { Metadata } from "next"
// The public site (architecture §85): readable without signing in and, unlike
// the app, meant to be indexed.
export const metadata: Metadata = {
  robots: { index: true, follow: true },
}
export default function Layout({ children }: { children: React.ReactNode }) {
  return children
}
