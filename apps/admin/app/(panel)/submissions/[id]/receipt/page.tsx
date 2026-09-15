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
  const receipt = await loadReviewReceipt(workspace, id)
  if (!receipt) notFound()
  return (
    <SubmissionReceipt
      receipt={receipt}
      backHref={`/submissions?workspace=${workspace}&state=approved`}
    />
  )
}
