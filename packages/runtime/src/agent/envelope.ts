import { createHash } from "node:crypto"
import { z } from "zod"
import { toolGrants } from "@agentonic/contracts/tools"
import {
  batchCeilings,
  type RuntimeErrorCode,
} from "@agentonic/contracts/runtime-protocol"
import { compose, configurationSchema } from "./prompt-loader"

export class RuntimeError extends Error {
  constructor(public code: RuntimeErrorCode) {
    super(code)
  }
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const gmailId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
/** IDs and outcomes only: never arguments or content. */
export const historyAction = z
  .object({
    operation: z.string().regex(/^[a-z][a-z.]{1,40}$/),
    status: z.string().regex(/^[a-z_]{1,40}$/),
    draftId: gmailId.optional(),
    messageId: gmailId.optional(),
    threadId: gmailId.optional(),
  })
  .strict()
export const envelopeSchema = z
  .object({
    environment: z.literal("staging"),
    audience: z.literal("private"),
    expiresAt: z.string().datetime({ offset: true }),
    configurationJson: z.string().max(500000),
    contentSha256: hash,
    composedPromptSha256: hash,
    assetManifestJson: z.string().max(10000),
    assetManifestSha256: hash,
    accessJson: z.string().max(100000),
    accessSha256: hash,
    query: z.string().min(1).max(1000),
    history: z
      .array(
        z
          .object({
            query: z.string().max(1000),
            answer: z.string().max(batchCeilings.answerChars),
            // The Gmail actions that turn proposed and what became of them (B8, §67).
            actions: z.array(historyAction).max(20).optional(),
          })
          .strict()
      )
      .max(9),
    passages: z
      .array(z.object({ id: z.uuid(), text: z.string().max(12000) }).strict())
      .max(8),
    // The owner's accepted writing-style guide, when the version's knowledge
    // holds one made for this agent (§68).
    styleGuide: z.string().min(1).max(12000).optional(),
  })
  .strict()
const accessSchema = z
  .object({
    version: z.literal(1),
    collectionIds: z.array(z.uuid()).max(20),
    tools: toolGrants,
    collections: z.array(z.unknown()),
  })
  .strict()

export function expired(expiresAt: string) {
  return Date.parse(expiresAt) <= Date.now()
}

/**
 * Verifies the frozen candidate bytes the platform supplied before any model
 * call: configuration, generated assets and access snapshot must match their
 * hashes, and the composed prompt must match the frozen composition.
 */
export function readEnvelope(value: unknown) {
  const parsed = envelopeSchema.safeParse(value)
  if (!parsed.success) throw new RuntimeError("candidate_mismatch")
  const e = parsed.data
  if (expired(e.expiresAt)) throw new RuntimeError("preview_expired")
  if (
    digest(e.configurationJson) !== e.contentSha256 ||
    digest(e.assetManifestJson) !== e.assetManifestSha256 ||
    digest(e.accessJson) !== e.accessSha256
  )
    throw new RuntimeError("candidate_mismatch")
  try {
    const configuration = configurationSchema.parse(
      JSON.parse(e.configurationJson)
    )
    const composed = compose(configuration)
    if (composed.composedPromptSha256 !== e.composedPromptSha256)
      throw new RuntimeError("candidate_mismatch")
    const assets = z
      .array(z.object({ path: z.string(), sha256: hash }).strict())
      .parse(JSON.parse(e.assetManifestJson))
    const expected = [
      { path: "prompts/system.md", sha256: digest(configuration.systemPrompt) },
      ...configuration.skills.map((s) => ({
        path: `skills/${s.name}.md`,
        sha256: digest(s.instructions),
      })),
    ]
    if (
      assets.length !== expected.length ||
      expected.some(
        (a) => !assets.some((b) => b.path === a.path && b.sha256 === a.sha256)
      )
    )
      throw new RuntimeError("candidate_mismatch")
    // Access is supplied and enforced by the broker. It is never
    // interpreted as model-granted authority.
    const access = accessSchema.parse(JSON.parse(e.accessJson))
    return { envelope: e, configuration, skills: composed.skills, access }
  } catch (error) {
    if (error instanceof RuntimeError) throw error
    throw new RuntimeError("candidate_mismatch")
  }
}
export type Candidate = ReturnType<typeof readEnvelope>
