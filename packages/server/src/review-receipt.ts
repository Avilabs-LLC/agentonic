import "server-only"
import { randomUUID } from "node:crypto"
import { withIdentity } from "@agentonic/database/client"
import { uuid } from "@agentonic/contracts/identity"
import { reviewReceipt } from "@agentonic/contracts/review-receipt"
import { requireVerifiedUser } from "./auth"
export async function loadReviewReceipt(
  workspaceId: string,
  submissionId: string
) {
  if (![workspaceId, submissionId].every((id) => uuid.safeParse(id).success))
    return null
  const user = await requireVerifiedUser("admin")
  return withIdentity(user.authId, workspaceId, async (tx) => {
    const rows = await tx.$queryRaw<{ result: unknown }[]>`
      SELECT agentonic.approved_review_receipt(${submissionId}::uuid,${randomUUID()}::uuid) result`
    if (!rows[0]?.result) return null
    return reviewReceipt.parse(rows[0].result)
  })
}
