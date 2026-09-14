import "server-only"
import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
export async function customerWorkspace(
  searchParams: Promise<{ workspace?: string }>
) {
  const identity = await requireIdentity("customer")
  const query = await searchParams
  const selected = query.workspace
    ? identity.workspaces.find((w) => w.id === query.workspace)
    : identity.workspaces[0]
  if (!selected) notFound()
  return { identity, selected }
}
