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
