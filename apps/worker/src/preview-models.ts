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
  reasoning?: string | null,
  /** The output ceiling actually requested, when larger than the profile's (§67). */
  maxOutput?: number,
  /**
   * The input's tokens as OpenAI counted them (§79), held with a 5 % and
   * 256-token margin. Without a count, every byte of the request is held as a
   * token, the bound that can't be exceeded.
   */
  inputTokens?: number
) {
  const p = previewModelProfile(model, reasoning)
  const input =
    inputTokens === undefined
      ? Buffer.byteLength(body) + 4096
      : Math.ceil(inputTokens * 1.05) + 256
  return Math.ceil(
    input * p.inputRate + (maxOutput ?? p.maxOutput) * p.outputRate
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
