import type { Metadata } from "next"
import { SiteTerms } from "@workspace/ui/components/site-page"
export const metadata: Metadata = { title: "Terms of service" }
export default function Page() {
  return <SiteTerms locale="en" />
}
