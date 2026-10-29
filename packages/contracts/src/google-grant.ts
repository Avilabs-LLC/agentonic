import { formatUtcMinute as at } from "./format"

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * What a Gmail or Drive account's card says about Google's authorization
 * (architecture §84). While the Google app is in Testing a consent lasts 7
 * days: the card shows until when, warns the day before, and after the date
 * asks for a reconnect as Google will. Without a date, only the status counts.
 */
export function googleGrantState(
  status: "connected" | "reconnect" | "disconnected",
  expiresAt: string | null,
  now = Date.now()
): { kind: "connected" | "soon" | "reconnect"; text: string } {
  if (status !== "connected")
    return { kind: "reconnect", text: "Necesita volver a conectarse" }
  if (!expiresAt) return { kind: "connected", text: "Cuenta conectada" }
  const ends = Date.parse(expiresAt)
  if (ends <= now)
    return {
      kind: "reconnect",
      text: `La autorización de Google venció el ${at(expiresAt)}. Vuelve a conectar la cuenta.`,
    }
  if (ends - now <= DAY_MS)
    return {
      kind: "soon",
      text: `La autorización de Google vence el ${at(expiresAt)}. Vuelve a conectar la cuenta para que el agente siga respondiendo.`,
    }
  return {
    kind: "connected",
    text: `Autorización de Google hasta el ${at(expiresAt)}`,
  }
}
