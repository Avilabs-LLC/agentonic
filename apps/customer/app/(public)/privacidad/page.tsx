import type { Metadata } from "next"
import { SitePrivacy } from "@workspace/ui/components/site-page"
export const metadata: Metadata = { title: "Política de privacidad" }
export default function Page() {
  return <SitePrivacy locale="es" />
}
