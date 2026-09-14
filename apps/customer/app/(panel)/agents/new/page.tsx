import { redirect } from "next/navigation"
import { customerWorkspace } from "@/lib/workspace"
// Preserve old bookmarks while creation lives in the agents-list dialog.
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>
}) {
  const { selected } = await customerWorkspace(searchParams)
  redirect(`/agents?workspace=${selected.id}&create=1`)
}
