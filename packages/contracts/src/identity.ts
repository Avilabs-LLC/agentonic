import { z } from "zod"
export const uuid = z.uuid()
export const signInSchema = z.object({
  email: z.email("Introduce un correo válido."),
  password: z.string().min(1, "Introduce tu contraseña."),
})
export type SignInInput = z.infer<typeof signInSchema>
export type ActionResult = { ok: true } | { ok: false; message: string }
export type AppKind = "admin" | "customer"
export type NavigationItem = {
  href: string
  title: string
  description: string
  group: string
  enabled: boolean
  icon:
    | "home"
    | "agents"
    | "review"
    | "knowledge"
    | "connections"
    | "activity"
    | "chat"
    | "expiry"
    | "workspaces"
    | "deployments"
    | "costs"
    | "releases"
}
export const retentionPolicy = z
  .object({
    conversationsDays: z.number().int().min(1).max(3650),
    checkpointsDays: z.number().int().min(1).max(3650),
    memoryDays: z.number().int().min(1).max(3650),
    sourcesDays: z.number().int().min(1).max(3650),
    logsDays: z.number().int().min(1).max(3650),
    auditDays: z.number().int().min(1).max(3650),
    backupsDays: z.number().int().min(1).max(3650),
  })
  .strict()
// Account flows (architecture §54).
export const emailOnlySchema = z.object({
  email: z.email("Introduce un correo válido."),
})
export type EmailOnlyInput = z.infer<typeof emailOnlySchema>
export const newPasswordSchema = z
  .object({
    password: z
      .string()
      .min(10, "Usa al menos 10 caracteres.")
      .max(72, "Usa como máximo 72 caracteres."),
    confirmation: z.string(),
  })
  .refine((value) => value.password === value.confirmation, {
    path: ["confirmation"],
    message: "Las contraseñas no coinciden.",
  })
export type NewPasswordInput = z.infer<typeof newPasswordSchema>
export const mfaCodeSchema = z.object({
  code: z.string().regex(/^\d{6}$/, "Escribe los 6 dígitos de tu aplicación."),
})
export type MfaCodeInput = z.infer<typeof mfaCodeSchema>
/** The name every account starts with until its person chooses one (N7). */
export const PLACEHOLDER_NAME = "Miembro"
// A person's own name, set when accepting an invitation or in Mi cuenta; the
// database applies the same rules (migration 59).
export const displayNameSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, "Escribe tu nombre.")
    .max(120, "Usa como máximo 120 caracteres.")
    .refine(
      (value) =>
        ![...value].some(
          (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127
        ),
      "Usa solo letras, números y signos habituales."
    )
    // The placeholder is not a choice: it would keep the name prompt showing.
    .refine(
      (value) => value.toLowerCase() !== PLACEHOLDER_NAME.toLowerCase(),
      "Escribe tu nombre."
    ),
})
export type DisplayNameInput = z.infer<typeof displayNameSchema>
/** Whether this person still has to choose a name before using the customer app. */
export const nameRequired = (user: { displayName: string } | null | undefined) =>
  user?.displayName === PLACEHOLDER_NAME
/** Only a path on this app; anything else falls back. */
export function safeNext(next: unknown, fallback = "/") {
  if (
    typeof next !== "string" ||
    !next.startsWith("/") ||
    next.startsWith("//") ||
    next.startsWith("/\\") ||
    [...next].some((character) => character.charCodeAt(0) < 32)
  )
    return fallback
  try {
    const url = new URL(next, "https://agentonic.invalid")
    return url.origin === "https://agentonic.invalid"
      ? url.pathname + url.search
      : fallback
  } catch {
    return fallback
  }
}
export const mfaEnrollmentCode = mfaCodeSchema.extend({ factorId: uuid })
