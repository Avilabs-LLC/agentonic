export const documentErrors = {
  invalid_file: "El archivo no es válido. Usa PDF, texto UTF-8 o Markdown.",
  too_large: "El archivo supera el límite de 10 MB.",
  collection_required:
    "Selecciona una colección disponible antes de subir el documento.",
  session_expired:
    "Tu sesión caducó. Recarga la página e inicia sesión antes de volver a subir el archivo.",
  origin_mismatch:
    "La dirección de esta pestaña no coincide con la aplicación. Abre de nuevo la app y vuelve a intentarlo.",
  access_denied:
    "No tienes permiso para subir documentos a esta colección o ya no está disponible.",
  storage_failed:
    "No se pudo guardar el archivo. La subida no quedó disponible; puedes intentarlo de nuevo.",
  completion_failed:
    "No se pudo confirmar la subida. El documento no quedó disponible; puedes intentarlo de nuevo.",
  headers_too_large:
    "El navegador envía demasiados datos de sesión para este servidor. Recarga después de reiniciar el servidor de desarrollo.",
  unavailable:
    "No se pudo confirmar la subida. Comprueba la lista de documentos antes de volver a intentarlo.",
} as const
export type DocumentError = keyof typeof documentErrors
export function documentErrorMessage(code: unknown) {
  return typeof code === "string" && Object.hasOwn(documentErrors, code)
    ? documentErrors[code as DocumentError]
    : documentErrors.unavailable
}

export function documentUploadFailure(
  code: unknown,
  status: number,
  reference: string | null
) {
  const known = typeof code === "string" && Object.hasOwn(documentErrors, code)
  const resolved = known
    ? code
    : status === 401
      ? "session_expired"
      : status === 413
        ? "too_large"
        : status === 431
          ? "headers_too_large"
          : "unavailable"
  const message = documentErrorMessage(resolved)
  const safeReference =
    reference &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      reference
    )
      ? reference
      : null
  const safeStatus =
    Number.isInteger(status) && status >= 100 && status <= 599 ? status : 0
  return `${message} (HTTP ${safeStatus}${safeReference ? ` · Ref. ${safeReference}` : " · Sin referencia del servidor"})`
}
