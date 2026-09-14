"use client"
import { useState } from "react"
import { Button } from "@workspace/ui/components/button"
import { notify } from "@workspace/ui/lib/toast"
export function DocumentDownload({
  objectId,
  workspaceId,
  title,
}: {
  objectId: string
  workspaceId: string
  title: string
}) {
  const [pending, setPending] = useState(false)
  async function download() {
    if (pending) return
    setPending(true)
    try {
      const response = await fetch(
        `/api/documents/${objectId}?${new URLSearchParams({ workspace: workspaceId })}`,
        { cache: "no-store", redirect: "error" }
      )
      if (!response.ok) {
        notify.destructive(
          response.status === 401
            ? "Tu sesión caducó. Recarga la página e inicia sesión."
            : response.status === 404
              ? "El documento ya no está disponible o no tienes permiso para descargarlo."
              : `No se pudo descargar el documento. Inténtalo de nuevo. (HTTP ${response.status})`
        )
        return
      }
      // A login/error page must never be saved as the customer's document.
      if (
        !response.headers
          .get("Content-Disposition")
          ?.startsWith("attachment;") ||
        !["application/pdf", "text/plain", "text/markdown"].includes(
          response.headers.get("Content-Type")?.split(";")[0] ?? ""
        )
      ) {
        notify.destructive(
          "El servidor no devolvió un documento válido. Recarga la página e inténtalo de nuevo."
        )
        return
      }
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const link = document.createElement("a")
      link.href = url
      link.download = title
      document.body.appendChild(link)
      link.click()
      link.remove()
      // Let the browser acquire the blob before releasing the temporary URL.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
      notify.success("Descarga iniciada.")
    } catch {
      notify.destructive(
        "No se pudo descargar el documento. Comprueba la conexión e inténtalo de nuevo."
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <Button size="sm" variant="ghost" disabled={pending} onClick={download}>
      {pending ? "Descargando…" : "Descargar"}
    </Button>
  )
}
