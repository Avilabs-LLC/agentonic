export const formatCount = (value: number) =>
  new Intl.NumberFormat("es-VE").format(value)
export function formatMoney(value: number | null, currency = "USD") {
  return value === null
    ? "Sin medir"
    : new Intl.NumberFormat("es-VE", { style: "currency", currency }).format(
        value
      )
}
export function formatDate(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat("es-VE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(value)
}
export function formatPathSegment(segment: string) {
  return /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(segment)
    ? segment.slice(0, 8)
    : decodeURIComponent(segment)
}

/** Stable es-VE UTC timestamps for HTML rendered by both Node and browsers.
 * Intl locale data differs across engines (including spaces in day periods).
 */
export function formatUtcDateTime(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value
  if (!Number.isFinite(date.getTime())) return "No disponible"
  const hour = date.getUTCHours()
  const minute = String(date.getUTCMinutes()).padStart(2, "0")
  const second = String(date.getUTCSeconds()).padStart(2, "0")
  return `${date.getUTCDate()}/${date.getUTCMonth() + 1}/${date.getUTCFullYear()}, ${hour % 12 || 12}:${minute}:${second} ${hour < 12 ? "a. m." : "p. m."}`
}
