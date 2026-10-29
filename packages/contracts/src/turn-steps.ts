import { z } from "zod"
import { gmailToolOperation } from "./gmail"
import { driveOperation } from "./drive"
import { webArguments, type WebOperation } from "./web"

/**
 * What a chat or preview turn did, step by step, as the broker ran its tool
 * calls (§74). The person sees the steps while the turn runs and folded above
 * the answer afterwards. A step names its tool, what it looked for or touched
 * (a search's terms, a message's subject, a page's site, a file's name), how
 * many items it found and how it ended. Steps live with the turn and are
 * scrubbed with it.
 */
export const MAX_TURN_STEPS = 40
export const TURN_STEP_TARGET = 200
export const turnStepTool = z.enum([
  ...gmailToolOperation.options,
  ...driveOperation.options,
  ...(Object.keys(webArguments) as WebOperation[]),
])
export const turnStepStatus = z.enum(["running", "done", "proposed", "failed"])
export const turnStep = z
  .object({
    tool: turnStepTool,
    target: z.string().max(TURN_STEP_TARGET).nullable(),
    count: z.number().int().min(0).max(1000).nullable(),
    status: turnStepStatus,
  })
  .strict()
export const turnSteps = z.array(turnStep).max(MAX_TURN_STEPS)
export type TurnStep = z.infer<typeof turnStep>
export type TurnStepTool = z.infer<typeof turnStepTool>

/** One line of untrusted text, bounded for a step. */
export function stepText(value: unknown) {
  if (typeof value !== "string") return null
  const line = value.replace(/\s+/g, " ").trim()
  if (!line) return null
  return line.length > TURN_STEP_TARGET
    ? line.slice(0, TURN_STEP_TARGET - 1) + "…"
    : line
}
