import { z } from "zod"

/**
 * Synthetic tool data for a platform evaluation case (architecture §51). A case
 * that carries fixtures runs with the frozen version's Gmail, Drive or web tools, but
 * every tool call is answered from these records: no mailbox, page or provider
 * is reached, and writes are only proposed. The database defines the cases.
 */
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
export const fixtureMessage = z
  .object({
    id,
    from: z.string().min(1).max(254),
    to: z.string().min(1).max(254),
    subject: z.string().min(1).max(200),
    date: z.string().min(1).max(64),
    text: z.string().min(1).max(4000),
  })
  .strict()
export const fixturePage = z
  .object({
    url: z.url().max(2048),
    title: z.string().min(1).max(250),
    text: z.string().min(1).max(8000),
  })
  .strict()
/** A Drive file the evaluated agent was given (architecture §62). */
export const fixtureFile = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{10,200}$/),
    name: z.string().min(1).max(200),
    mimeType: z.string().min(1).max(100),
    text: z.string().min(1).max(8000),
  })
  .strict()
export const evaluationFixtures = z
  .object({
    mailbox: z.array(fixtureMessage).min(1).max(10).optional(),
    web: z.array(fixturePage).min(1).max(5).optional(),
    drive: z.array(fixtureFile).min(1).max(5).optional(),
  })
  .strict()
  .refine((f) => !!f.mailbox || !!f.web || !!f.drive)
export type EvaluationFixtures = z.infer<typeof evaluationFixtures>
/**
 * One tool call an evaluated agent made, shown to the grader. A write carries
 * `pendingApproval: true`: it was proposed for confirmation, not executed (§71).
 */
export type FixtureCall = {
  tool: string
  arguments: unknown
  pendingApproval?: true
}
