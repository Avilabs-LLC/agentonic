import { z } from "zod"
import { gmailLabels } from "./gmail"
import { driveLabels } from "./drive"
import { isSelectableModel, modelConfiguration } from "./models"
// Scheduled jobs (architecture §58).
const uuid = z.uuid()
export const scheduleCadence = z.enum(["daily", "weekdays", "weekly", "hours"])
export type ScheduleCadence = z.infer<typeof scheduleCadence>
export const cadenceLabels: Record<ScheduleCadence, string> = {
  daily: "Cada día",
  weekdays: "Días laborables",
  weekly: "Cada semana",
  hours: "Cada cierto número de horas",
}
/** ISO weekdays, Monday first. */
export const weekdayLabels: Record<number, string> = {
  1: "Lunes",
  2: "Martes",
  3: "Miércoles",
  4: "Jueves",
  5: "Viernes",
  6: "Sábado",
  7: "Domingo",
}
/** Writes a schedule may pre-authorize, one per run (owner direction, 8 Oct; Drive 9 Oct). */
export const scheduleWrites = [
  "gmail.send",
  "gmail.drafts.create",
  "gmail.drafts.update",
  "gmail.drafts.delete",
  "drive.docs.create",
  "drive.docs.update",
] as const
export const scheduleWrite = z.enum(scheduleWrites)
const writeLabels: Record<string, string> = { ...gmailLabels, ...driveLabels }
export const autonomyLabels: Record<string, string> = Object.fromEntries(
  scheduleWrites.map((op) => [op, writeLabels[op]!])
)
export const scheduleForm = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Escribe un nombre.")
      .max(60, "Máximo 60 caracteres."),
    instruction: z
      .string()
      .trim()
      .min(1, "Escribe qué debe hacer el agente.")
      .max(600, "Máximo 600 caracteres."),
    cadence: scheduleCadence,
    timeOfDay: z
      .string()
      .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, "Elige una hora."),
    weekday: z.number().int().min(1).max(7).nullable(),
    everyHours: z.number().int().min(1).max(24).nullable(),
    timezone: z.string().min(1).max(64),
    model: z.string(),
    reasoning: z.string().nullable(),
    autonomy: z.array(scheduleWrite),
    consent: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.cadence === "weekly" && v.weekday === null)
      ctx.addIssue({
        code: "custom",
        path: ["weekday"],
        message: "Elige un día.",
      })
    if (v.cadence !== "weekly" && v.weekday !== null)
      ctx.addIssue({
        code: "custom",
        path: ["weekday"],
        message: "Solo para cada semana.",
      })
    if (v.cadence === "hours" && v.everyHours === null)
      ctx.addIssue({
        code: "custom",
        path: ["everyHours"],
        message: "Indica cada cuántas horas.",
      })
    if (v.cadence !== "hours" && v.everyHours !== null)
      ctx.addIssue({
        code: "custom",
        path: ["everyHours"],
        message: "Solo para cada cierto número de horas.",
      })
    if (new Set(v.autonomy).size !== v.autonomy.length)
      ctx.addIssue({ code: "custom", path: ["autonomy"], message: "Repetida." })
    if (v.autonomy.length && !v.consent)
      ctx.addIssue({
        code: "custom",
        path: ["consent"],
        message: "Autoriza las acciones automáticas para continuar.",
      })
    if (
      !modelConfiguration.safeParse({ model: v.model, reasoning: v.reasoning })
        .success ||
      !isSelectableModel(v.model)
    )
      ctx.addIssue({
        code: "custom",
        path: ["model"],
        message: "Elige un modelo.",
      })
  })
export type ScheduleForm = z.infer<typeof scheduleForm>
export const scheduleRunStatus = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "skipped",
])
export const runReasonLabels: Record<string, string> = {
  no_deployment: "El agente no tenía una versión en funcionamiento",
  offline: "El agente no estaba disponible",
  busy: "La ejecución anterior seguía en curso",
  turn_limit: "La conversación alcanzó su límite",
  member_inactive: "Tu acceso al espacio no estaba activo",
  agent_unavailable: "El agente no estaba disponible",
  google_reconnect: "Google pide volver a conectar la cuenta",
}
export const scheduleRun = z.object({
  id: uuid,
  scheduledFor: z.string(),
  manual: z.boolean(),
  status: scheduleRunStatus,
  reason: z.string().nullable(),
  conversationId: uuid.nullable(),
  actions: z.array(
    z.object({
      operation: z.string(),
      status: z.string(),
      automatic: z.boolean(),
    })
  ),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
})
export type ScheduleRun = z.infer<typeof scheduleRun>
export const schedule = z.object({
  id: uuid,
  name: z.string(),
  instruction: z.string(),
  cadence: scheduleCadence,
  timeOfDay: z.string(),
  weekday: z.number().nullable(),
  everyHours: z.number().nullable(),
  timezone: z.string(),
  model: z.string(),
  reasoning: z.string().nullable(),
  autonomy: z.array(scheduleWrite),
  status: z.enum(["active", "paused"]),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  createdAt: z.string(),
  runs: z.array(scheduleRun),
})
export type Schedule = z.infer<typeof schedule>
export const scheduleState = z.object({
  timezone: z.string(),
  deployment: z
    .object({
      id: uuid,
      online: z.boolean(),
      authorizedUntil: z.string(),
      models: z.array(
        z.object({ model: z.string(), reasoning: z.string().nullable() })
      ),
      writes: z.array(z.string()),
    })
    .nullable(),
  schedules: z.array(schedule),
})
export type ScheduleState = z.infer<typeof scheduleState>
export const scheduleCommand = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("state"),
      payload: z.object({ agentId: uuid }).strict(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("create"),
      payload: z.object({ agentId: uuid, requestId: uuid }).and(scheduleForm),
    })
    .strict(),
  z
    .object({
      operation: z.literal("update"),
      payload: z.object({ id: uuid }).and(scheduleForm),
    })
    .strict(),
  z
    .object({
      operation: z.enum(["pause", "resume", "delete", "run"]),
      payload: z.object({ id: uuid }).strict(),
    })
    .strict(),
])
export const scheduleCommandErrors: Record<string, string> = {
  limit: "Este agente ya tiene 10 programaciones tuyas.",
  rate_limit: "Espera un minuto antes de volver a ejecutarla.",
}
const weekdayPlurals: Record<number, string> = {
  1: "lunes",
  2: "martes",
  3: "miércoles",
  4: "jueves",
  5: "viernes",
  6: "sábados",
  7: "domingos",
}
/** "Cada día a las 08:00", "Los miércoles a las 18:30", "Cada 6 h desde las 08:00". */
export function cadenceDescription(s: {
  cadence: ScheduleCadence
  timeOfDay: string
  weekday: number | null
  everyHours: number | null
}) {
  const at = s.timeOfDay.slice(0, 5)
  if (s.cadence === "daily") return `Cada día a las ${at}`
  if (s.cadence === "weekdays") return `Días laborables a las ${at}`
  if (s.cadence === "weekly")
    return `Los ${weekdayPlurals[s.weekday ?? 1]} a las ${at}`
  return `Cada ${s.everyHours} h desde las ${at}`
}
