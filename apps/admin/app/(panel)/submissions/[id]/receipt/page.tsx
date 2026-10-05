import { loadLifecycle } from "@agentonic/server/lifecycle"
import { AgentLifecycle } from "@workspace/ui/components/agent-lifecycle"
import { lifecycleAction } from "../../actions"
import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadReviewReceipt } from "@agentonic/server/review-receipt"
import { SubmissionReceipt } from "@workspace/ui/components/submission-receipt"
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<{ workspace?: string }>
}) {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const { id } = await params
  const { workspace } = await searchParams
  if (!workspace) notFound()
  const [receipt, lifecycle] = await Promise.all([
    loadReviewReceipt(workspace, id),
    loadLifecycle("admin", workspace, id),
  ])
  if (!receipt || !lifecycle) notFound()
  return (
    <div className="space-y-6">
      <SubmissionReceipt
        receipt={receipt}
        backHref={`/submissions?workspace=${workspace}&state=approved`}
      />
      <div className="mx-auto w-full max-w-4xl">
        <AgentLifecycle
          state={lifecycle}
          workspaceId={workspace}
          submissionId={id}
          action={lifecycleAction.bind(null, workspace)}
          audience="staff"
          now={new Date().toISOString()}
        />
      </div>
    </div>
  )
}
