export const formatCount = (value: number) =>
  new Intl.NumberFormat("es-VE").format(value)
const cents = new Intl.NumberFormat("es-VE", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})
/** US dollars to the cent, the one way both apps show money: "US$2,36".
 * More decimals read as precision the figures don't have (owner direction,
 * 13 October 2026); a positive amount under half a cent reads as such
 * instead of a zero. */
export function formatUsd(value: number) {
  return value > 0 && value < 0.005
    ? "menos de US$0,01"
    : `US$${cents.format(value)}`
}
export function formatMoney(value: number | null) {
  return value === null ? "Sin medir" : formatUsd(value)
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

/** The same UTC timestamp to the minute, split for compact table cells. */
export function formatUtcParts(value: string | Date) {
  const date = typeof value === "string" ? new Date(value) : value
  if (!Number.isFinite(date.getTime()))
    return { date: "No disponible", time: "" }
  const hour = date.getUTCHours()
  const minute = String(date.getUTCMinutes()).padStart(2, "0")
  return {
    date: `${date.getUTCDate()}/${date.getUTCMonth() + 1}/${date.getUTCFullYear()}`,
    time: `${hour % 12 || 12}:${minute} ${hour < 12 ? "a. m." : "p. m."} UTC`,
  }
}

/** One line, to the minute: "9/10/2026, 7:40 p. m. UTC". */
export function formatUtcMinute(value: string | Date) {
  const { date, time } = formatUtcParts(value)
  return time ? `${date}, ${time}` : date
}
