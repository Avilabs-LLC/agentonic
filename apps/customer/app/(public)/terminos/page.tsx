import type { Metadata } from "next"
import { SiteTerms } from "@workspace/ui/components/site-page"
export const metadata: Metadata = { title: "Términos del servicio" }
export default function Page() {
  return <SiteTerms locale="es" />
}
