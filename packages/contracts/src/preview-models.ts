import { z } from "zod"
import { modelId, modelCatalog } from "./models"

export const DEFAULT_PREVIEW_MODEL = "gpt-4.1-mini-2025-04-14"
export const previewModel = modelId
export type PreviewModel = z.infer<typeof previewModel>
export const previewModels = modelCatalog.map((m) => ({
  id: m.id,
  name: m.name,
  description: m.levels.length
    ? "Razonamiento configurable"
    : "Sin nivel de razonamiento",
}))
export function previewModelName(id: string) {
  return previewModels.find((model) => model.id === id)?.name ?? id
}
