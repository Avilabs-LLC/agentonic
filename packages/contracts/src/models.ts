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
    evaluationUsd: 1,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    levels: ["none", "low", "medium", "high", "xhigh"],
    defaultLevel: "medium",
    inputRate: 2.5,
    outputRate: 15,
    evaluationUsd: 2,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    levels: ["low", "medium", "high", "xhigh", "max"],
    defaultLevel: "low",
    inputRate: 10,
    outputRate: 50,
    evaluationUsd: 5,
  },
  {
    id: "gpt-4.1-mini-2025-04-14",
    name: "GPT-4.1 mini",
    levels: [],
    defaultLevel: null,
    inputRate: 0.4,
    outputRate: 1.6,
    evaluationUsd: 1,
    // Kept for history: earlier turns, results and approvals name it. It fell
    // for hidden instructions in tool cases, so it is no longer offered (§56).
    retired: true,
  },
] satisfies {
  id: z.infer<typeof modelId>
  name: string
  levels: z.infer<typeof reasoningLevel>[]
  defaultLevel: z.infer<typeof reasoningLevel> | null
  inputRate: number
  outputRate: number
  /**
   * What one evaluation run of this model needs (§70): its spend plus room for
   * one call's reservation, since each call reserves its full output ceiling
   * before it starts. Measured 13 Oct on runtime 0.7.0 with ten cases: GPT-5.4
   * spent about US$0.55 and reserved up to US$0.40 a call; GPT-6 Astra about
   * US$2 and up to US$1.50.
   */
  evaluationUsd: number
  retired?: true
}[]
/** Models that new evaluations and test chats may choose. */
export const selectableModels = modelCatalog.filter(
  (m) => !("retired" in m && m.retired)
)
export const isSelectableModel = (id: string) =>
  selectableModels.some((m) => m.id === id)
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
  .array(
    modelConfiguration.refine(
      (value) => isSelectableModel(value.model),
      "Este modelo ya no está disponible."
    )
  )
  .min(1)
  .max(16)
  .refine(
    (models) =>
      new Set(models.map(modelConfigurationKey)).size === models.length,
    "No repitas el mismo modelo y nivel."
  )
/**
 * The suggested limit for one evaluation of these configurations (§70). Runs of
 * one evaluation share its limit, so each configuration adds its model's
 * allowance, doubled from high reasoning up, within the US$50 maximum.
 */
export function suggestedEvaluationBudget(models: ModelConfiguration[]) {
  const total = models.reduce((sum, m) => {
    const profile = modelCatalog.find((p) => p.id === m.model)!
    const deep = ["high", "xhigh", "max"].includes(m.reasoning ?? "")
    return sum + profile.evaluationUsd * (deep ? 2 : 1)
  }, 0)
  return Math.min(50, Math.max(1, total))
}
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
