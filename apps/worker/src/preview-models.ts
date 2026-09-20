import { modelCatalog } from "@agentonic/contracts/models"
import {
  DEFAULT_PREVIEW_MODEL,
  type PreviewModel,
} from "@agentonic/contracts/preview-models"

// Standard short-context list prices, in micro-USD/token. Cache discounts are
// not assumed. Output usage includes reasoning tokens.
export function previewModelProfile(
  model: PreviewModel,
  reasoning?: string | null
) {
  const profile = modelCatalog.find((m) => m.id === model)!
  return {
    inputRate: profile.inputRate,
    outputRate: profile.outputRate,
    maxOutput:
      model === DEFAULT_PREVIEW_MODEL
        ? 1000
        : ["high", "xhigh", "max"].includes(reasoning ?? "")
          ? 16384
          : 4096,
  }
}
export function previewReservation(
  model: PreviewModel,
  body: string,
  reasoning?: string | null
) {
  const p = previewModelProfile(model, reasoning)
  return Math.ceil(
    (Buffer.byteLength(body) + 4096) * p.inputRate + p.maxOutput * p.outputRate
  )
}
export function previewCost(
  model: PreviewModel,
  input: number,
  output: number
) {
  const p = previewModelProfile(model)
  return Math.ceil(input * p.inputRate + output * p.outputRate)
}
