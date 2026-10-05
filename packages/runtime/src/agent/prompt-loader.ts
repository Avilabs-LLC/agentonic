import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { z } from "zod"
// The packaged artifact keeps this file at src/surfaces/preview.mjs, so the
// policy resolves to the artifact's own checksummed prompts/platform.md.
export const policy = readFileSync(
  new URL("../../prompts/platform.md", import.meta.url),
  "utf8"
)
const skill = z
  .object({
    name: z
      .string()
      .max(80)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
    instructions: z
      .string()
      .min(1)
      .max(16000)
      .refine((x) => Boolean(x.trim())),
  })
  .strict()
export const configurationSchema = z
  .object({
    version: z.literal(1),
    systemPrompt: z
      .string()
      .min(1)
      .max(32000)
      .refine((x) => Boolean(x.trim())),
    skills: z.array(skill).max(20),
  })
  .strict()
  .refine((c) => new Set(c.skills.map((s) => s.name)).size === c.skills.length)
export function compose(input: unknown) {
  const configuration = configurationSchema.parse(input)
  const messages = [
    { role: "system" as const, content: policy },
    { role: "developer" as const, content: configuration.systemPrompt },
  ]
  return {
    messages,
    skills: configuration.skills,
    sha256: createHash("sha256")
      .update(JSON.stringify({ messages, skills: configuration.skills }))
      .digest("hex"),
    composedPromptSha256: createHash("sha256")
      .update(policy + "\n\n" + configuration.systemPrompt)
      .digest("hex"),
  }
}
