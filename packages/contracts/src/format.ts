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
