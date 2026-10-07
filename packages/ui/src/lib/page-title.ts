import { formatPathSegment } from "@agentonic/contracts/format"

// Breadcrumb titles of pages outside the sidebar; record ids stay short ids.
const segmentTitles: Record<string, string> = {
  new: "Crear agente",
  preview: "Probar versión",
  receipt: "Comprobante",
  password: "Contraseña",
}
export function pageTitle(pathname: string) {
  const segment = pathname.split("/").filter(Boolean).at(-1) ?? ""
  return segmentTitles[segment] ?? formatPathSegment(segment)
}
