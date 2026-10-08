import "server-only"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import {
  accessCommand,
  accessResult,
  invitationAcceptance,
  invitationRequest,
  customerAgentCreation,
} from "@agentonic/contracts/access"
import { uuid, type AppKind } from "@agentonic/contracts/identity"
import { withIdentity } from "@agentonic/database/client"
import { requireVerifiedUser } from "./auth"
import { latestCreationTemplate } from "./catalog"

export async function createCustomerAgent(workspaceId: string, input: unknown) {
  const parsed = customerAgentCreation.safeParse(input)
  if (!uuid.safeParse(workspaceId).success || !parsed.success)
    return { ok: false as const }
  const actor = await requireVerifiedUser("customer")
  try {
    return await withIdentity(
      actor.authId,
      workspaceId,
      async (tx) => {
        // The command acquires the workspace lock and rechecks creation rights.
        const templateVersionId = await latestCreationTemplate(tx)
        if (!templateVersionId) return { ok: false as const }
        const rows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT agentonic.access_command('agent.create',${JSON.stringify({ ...parsed.data, templateVersionId })}::jsonb,${randomUUID()}::uuid) result`
        const result = accessResult.parse(rows[0]?.result)
        // Recheck the executable default after acquiring that lock. Throwing
        // rolls back creation if publication/revocation changed the selection.
        if (
          result.ok &&
          (await latestCreationTemplate(tx)) !== templateVersionId
        )
          throw new Error("Creation default changed")
        return result
      },
      actor.email
    )
  } catch {
    return { ok: false as const }
  }
}

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
  const actor = await requireVerifiedUser("customer")
  const tokenHash = createHash("sha256").update(parsed.data.token).digest("hex")
  try {
    // Joining and naming happen together: the name the person chose replaces
    // the "Miembro" placeholder, or nothing is accepted (N7).
    return await withIdentity(
      actor.authId,
      parsed.data.workspaceId,
      async (tx) => {
        const rows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT agentonic.access_command('invite.accept', ${JSON.stringify({ tokenHash })}::jsonb, ${randomUUID()}::uuid) AS result`
        const result = accessResult.parse(rows[0]?.result)
        if (!result.ok) return result
        const named = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT agentonic.set_display_name(${parsed.data.displayName}) AS ok`
        if (!named[0]?.ok) throw new Error("Name not saved")
        return result
      },
      actor.email
    )
  } catch {
    return { ok: false as const }
  }
}
/** Changes only the signed-in person's own name (N7). */
export async function setOwnDisplayName(app: AppKind, displayName: string) {
  const actor = await requireVerifiedUser(app)
  try {
    return await withIdentity(
      actor.authId,
      null,
      async (tx) => {
        const rows = await tx.$queryRaw<{ ok: boolean }[]>`
        SELECT agentonic.set_display_name(${displayName}) AS ok`
        return Boolean(rows[0]?.ok)
      },
      actor.email
    )
  } catch {
    return false
  }
}
