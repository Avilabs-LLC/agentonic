import { z } from "zod"

// Responses API capabilities and standard short-context rates, checked 2026-09-19.
// Rates are micro-USD/token; reasoning tokens count as output. Aliases are recorded
// as aliases, not represented as immutable upstream model snapshots.
export const modelId = z.enum([
  "gpt-5.4-mini",
  "gpt-5.4",
  "gpt-6-astra",
  "gpt-4.1-mini-2025-04-14",
])
export const reasoningLevel = z.enum([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
])
export const modelCatalog = [
  {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 mini",
    levels: ["none", "low", "medium", "high", "xhigh"],
    defaultLevel: "medium",
    inputRate: 0.75,
    outputRate: 4.5,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    levels: ["none", "low", "medium", "high", "xhigh"],
    defaultLevel: "medium",
    inputRate: 2.5,
    outputRate: 15,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    levels: ["low", "medium", "high", "xhigh", "max"],
    defaultLevel: "low",
    inputRate: 10,
    outputRate: 50,
  },
  {
    id: "gpt-4.1-mini-2025-04-14",
    name: "GPT-4.1 mini",
    levels: [],
    defaultLevel: null,
    inputRate: 0.4,
    outputRate: 1.6,
  },
] satisfies {
  id: z.infer<typeof modelId>
  name: string
  levels: z.infer<typeof reasoningLevel>[]
  defaultLevel: z.infer<typeof reasoningLevel> | null
  inputRate: number
  outputRate: number
}[]
export const modelConfiguration = z
  .object({ model: modelId, reasoning: reasoningLevel.nullable() })
  .strict()
  .refine((value) => {
    const profile = modelCatalog.find((m) => m.id === value.model)!
    return value.reasoning === null
      ? profile.levels.length === 0
      : (profile.levels as string[]).includes(value.reasoning)
  }, "Este nivel no está disponible para el modelo seleccionado.")
export type ModelConfiguration = z.infer<typeof modelConfiguration>
export const evaluationModels = z
  .array(modelConfiguration)
  .min(1)
  .max(16)
  .refine(
    (models) =>
      new Set(models.map(modelConfigurationKey)).size === models.length,
    "No repitas el mismo modelo y nivel."
  )
export const DEFAULT_MODEL_CONFIGURATION: ModelConfiguration = {
  model: "gpt-5.4-mini",
  reasoning: "medium",
}
export const reasoningLabels: Record<z.infer<typeof reasoningLevel>, string> = {
  none: "Sin razonamiento",
  low: "Bajo",
  medium: "Medio",
  high: "Alto",
  xhigh: "Muy alto",
  max: "Máximo",
}
export function modelConfigurationKey(c: ModelConfiguration) {
  return `${c.model}:${c.reasoning ?? "default"}`
}
export function modelConfigurationLabel(c: {
  model: string
  reasoning: string | null
}) {
  return `${modelCatalog.find((m) => m.id === c.model)?.name ?? c.model}${c.reasoning ? ` · ${reasoningLabels[c.reasoning as keyof typeof reasoningLabels] ?? c.reasoning}` : ""}`
}
