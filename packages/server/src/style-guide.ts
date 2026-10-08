import "server-only"
import { randomUUID } from "node:crypto"
import { withIdentity } from "@agentonic/database/client"
import { uuid } from "@agentonic/contracts/identity"
import {
  styleCommand,
  styleGuideState,
  type StyleCommand,
} from "@agentonic/contracts/style-guide"
import { requireVerifiedUser } from "./auth"
import { storeDocument } from "./documents"

// Aprender mi estilo (architecture §57). The database decides who may start,
// read and decide on a guide; this module only carries the verified identity.
async function query(
  workspace: string,
  run: (
    tx: Parameters<Parameters<typeof withIdentity>[2]>[0]
  ) => Promise<Record<string, unknown> | undefined>
) {
  uuid.parse(workspace)
  const user = await requireVerifiedUser("customer")
  return withIdentity(user.authId, workspace, run)
}
export async function loadStyleGuides(workspace: string, agentId: string) {
  const result = await query(workspace, async (tx) => {
    const rows = await tx.$queryRaw<
      { result: Record<string, unknown> }[]
    >`SELECT agentonic.style_guide_state(${uuid.parse(agentId)}::uuid) result`
    return rows[0]?.result
  })
  return styleGuideState.parse(result).guides
}
async function command(
  workspace: string,
  operation: string,
  payload: Record<string, unknown>
) {
  const result = await query(workspace, async (tx) => {
    const rows = await tx.$queryRaw<
      { result: Record<string, unknown> }[]
    >`SELECT agentonic.style_guide_command(${operation},${JSON.stringify(payload)}::jsonb,${randomUUID()}::uuid) result`
    return rows[0]?.result
  })
  if (!result) throw new Error("unavailable")
  return result as { ok: boolean; id?: string; code?: string }
}
export async function runStyleCommand(workspace: string, input: unknown) {
  const parsed: StyleCommand = styleCommand.parse(input)
  if (parsed.operation === "state")
    return {
      ok: true,
      guides: await loadStyleGuides(workspace, parsed.payload.agentId),
    }
  if (parsed.operation !== "accept")
    return command(workspace, parsed.operation, parsed.payload)
  // The reviewed text becomes an ordinary document the person uploads to a
  // collection they curate; only then is the draft marked accepted and erased.
  const { id, collectionId, markdown } = parsed.payload
  const stored = await storeDocument({
    workspaceId: workspace,
    collectionId,
    filename: "Guía de estilo de escritura.md",
    bytes: Buffer.from(markdown.endsWith("\n") ? markdown : `${markdown}\n`),
    contentType: "text/markdown",
  })
  if (!stored.ok) return { ok: false, code: stored.code }
  return command(workspace, "accept", { id, objectId: stored.id })
}
