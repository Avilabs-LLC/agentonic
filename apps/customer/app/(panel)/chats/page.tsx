import { runStagingChat } from "@agentonic/server/lifecycle"
import { chatList } from "@agentonic/contracts/lifecycle"
import { StagingChats } from "@workspace/ui/components/staging-chats"
import { customerWorkspace } from "@/lib/workspace"
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string; deployment?: string }>
}) {
  const { selected } = await customerWorkspace(searchParams)
  const params = await searchParams
  const data = chatList.parse(
    await runStagingChat(selected.id, { operation: "list", payload: {} })
  )
  return (
    <StagingChats
      workspaceId={selected.id}
      initial={data}
      initialDeployment={params.deployment}
    />
  )
}
