import "server-only"
import { withIdentity } from "@agentonic/database/client"
import { uuid } from "@agentonic/contracts/identity"
import { previewCommand } from "@agentonic/contracts/preview"
import { requireVerifiedUser } from "./auth"
export async function runPreviewCommand(workspaceId: string, input: unknown) {
  const parsed = previewCommand.safeParse(input)
  if (!uuid.safeParse(workspaceId).success || !parsed.success) return null
  const actor = await requireVerifiedUser("customer")
  try {
    return await withIdentity(
      actor.authId,
      workspaceId,
      async (tx) => {
        const rows = await tx.$queryRaw<
          { result: unknown }[]
        >`SELECT agentonic.preview_command(${parsed.data.operation}::text,${JSON.stringify(parsed.data.payload)}::jsonb) result`
        return rows[0]?.result ?? null
      },
      actor.email
    )
  } catch {
    return null
  }
}
