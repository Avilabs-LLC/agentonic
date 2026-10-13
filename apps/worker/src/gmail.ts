import { randomUUID } from "node:crypto"
import { z } from "zod"
import {
  gmailGrant,
  gmailGrantFor,
  gmailReads,
  parseGmailCall,
} from "@agentonic/contracts/gmail"
import {
  gmail,
  refresh,
  GoogleError,
  type GoogleConfig,
} from "@agentonic/connectors/google"
import { digest, seal, unseal } from "@agentonic/connectors/secrets"
import type { Execute, Lease } from "./pipeline"
/** How much of each message a search shows: more, with its thread, in batch turns (§67). */
export const searchExcerpt = (batch: boolean) => (batch ? 2000 : 500)
export async function executeGmail(
  name: string,
  args: unknown,
  grant: unknown,
  job: Lease,
  execute: Execute,
  config: GoogleConfig,
  options: { batch?: boolean } = {}
) {
  const batch = options.batch === true
  const g = gmailGrant.parse(grant),
    call = parseGmailCall(name, args)
  // A thread is read under the read grant (§68); the database checks that grant.
  const granted = gmailGrantFor(call.operation)
  if (!g.operations.some((op) => op === granted))
    throw new Error("gmail_denied")
  const payload = { connectionId: g.connectionId, operation: granted }
  if (gmailReads.some((op) => op === call.operation)) {
    const credential = await execute("gmail-read", job, payload)
    const secret = z
      .object({ refreshToken: z.string() })
      .parse(
        unseal(
          String(credential.credential),
          `gmail:${g.connectionId}`,
          config.keys
        )
      )
    let token: string
    try {
      token = await refresh(config, secret.refreshToken)
    } catch (error) {
      if (error instanceof GoogleError && error.code === "reconnect")
        await execute("gmail-reconnect", job, payload)
      throw error
    }
    await execute("gmail-check", job, payload)
    const result = await gmail(
      token,
      call.operation,
      call.arguments,
      String(credential.account),
      randomUUID()
    )
    await execute("gmail-check", job, payload)
    // A search can answer a bounded mailbox overview in one model tool call.
    // Expanding results requires the separate read grant, checked for each item.
    if (
      call.operation === "gmail.search" &&
      g.operations.includes("gmail.read")
    ) {
      const found = z
        .object({
          messages: z
            .array(z.object({ id: z.string() }))
            .max(10)
            .optional(),
        })
        .parse(result)
      const messages = []
      for (const item of found.messages ?? []) {
        const read = parseGmailCall("gmail.read", { id: item.id })
        const authority = {
          connectionId: g.connectionId,
          operation: read.operation,
        }
        await execute("gmail-check", job, authority)
        const content = z
          .object({
            id: z.string(),
            threadId: z.string().optional(),
            headers: z
              .array(z.object({ name: z.string(), value: z.string() }))
              .optional(),
            text: z.string(),
          })
          .parse(
            await gmail(
              token,
              read.operation,
              read.arguments,
              String(credential.account),
              randomUUID()
            )
          )
        await execute("gmail-check", job, authority)
        messages.push({
          id: content.id,
          ...(batch && content.threadId ? { threadId: content.threadId } : {}),
          headers: content.headers,
          excerpt: content.text.slice(0, searchExcerpt(batch)),
          untrusted: true,
        })
      }
      await execute("gmail-check", job, payload)
      return { messages }
    }
    return result
  }
  const id = randomUUID()
  return execute("gmail-propose", job, {
    ...payload,
    id,
    hash: digest(JSON.stringify(call.arguments)),
    argumentsCiphertext: seal(call.arguments, `invocation:${id}`, config.keys),
  })
}
