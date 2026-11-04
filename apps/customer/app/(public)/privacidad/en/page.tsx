import type { Metadata } from "next"
import { SitePrivacy } from "@workspace/ui/components/site-page"
export const metadata: Metadata = { title: "Privacy policy" }
export default function Page() {
  return <SitePrivacy locale="en" />
}
