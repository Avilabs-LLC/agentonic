import "server-only"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  accessCommand,
  accessResult,
  invitationAcceptance,
  invitationRequest,
} from "@agentonic/contracts/access"
import type { AppKind } from "@agentonic/contracts/identity"
import { withIdentity } from "@agentonic/database/client"
import { requireVerifiedUser } from "./auth"

// Only trusted server modules call this service. Auth identity and email always
// come from Supabase getUser; submitted workspace/resource IDs are requests, never authority.
async function execute(
  app: AppKind,
  workspaceId: string,
  operation: string,
  payload: unknown
) {
  const actor = await requireVerifiedUser(app)
  try {
    return await withIdentity(
      actor.authId,
      workspaceId,
      async (tx) => {
        const rows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT agentonic.access_command(${operation}::text, ${JSON.stringify(payload)}::jsonb, ${randomUUID()}::uuid) AS result`
        return accessResult.parse(rows[0]?.result)
      },
      actor.email
    )
  } catch {
    // Do not leak FK existence, private payloads, email addresses or raw DB errors.
    return { ok: false as const }
  }
}
export async function runAccessCommand(app: AppKind, input: unknown) {
  const parsed = accessCommand.safeParse(input)
  if (!parsed.success) return { ok: false as const }
  const { workspaceId, operation, payload } = parsed.data
  if (operation === "support.read" && app !== "admin")
    return { ok: false as const }
  return execute(app, workspaceId, operation, payload)
}
export async function issueWorkspaceInvitation(input: unknown) {
  const parsed = invitationRequest.safeParse(input)
  if (!parsed.success) return { ok: false as const }
  const token = randomBytes(32).toString("hex")
  const tokenHash = createHash("sha256").update(token).digest("hex")
  const { workspaceId, email, role } = parsed.data
  const result = await execute("customer", workspaceId, "invite.issue", {
    email,
    role,
    tokenHash,
    expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
  })
  // The caller must deliver this once through the eventual invitation flow.
  // Never persist/log the token or claim an email was sent here.
  return result.ok ? { ...result, token } : result
}
export async function acceptWorkspaceInvitation(input: unknown) {
  const parsed = invitationAcceptance.safeParse(input)
  if (!parsed.success) return { ok: false as const }
  return execute("customer", parsed.data.workspaceId, "invite.accept", {
    tokenHash: createHash("sha256").update(parsed.data.token).digest("hex"),
  })
}
