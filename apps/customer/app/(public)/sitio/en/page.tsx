import type { Metadata } from "next"
import { SiteHome } from "@workspace/ui/components/site-page"
export const metadata: Metadata = { title: "Agentonic" }
export default function Page() {
  return <SiteHome locale="en" />
}
