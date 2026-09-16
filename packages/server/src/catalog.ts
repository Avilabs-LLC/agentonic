import "server-only"
import type { Prisma } from "@agentonic/database/generated/client"

// Publication time, not lexical semver order. RLS and can_use_code enforce
// live workspace grants, repository scope, retirement and revocation.
export async function latestCreationTemplate(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT template_version_id AS id FROM agentonic.code_releases
    WHERE agentonic.can_use_code(id) AND execution_manifest->>'previewContract'='1'
    ORDER BY created_at DESC, id DESC LIMIT 1`
  return rows[0]?.id ?? null
}
