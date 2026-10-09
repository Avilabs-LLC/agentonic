import { notFound } from "next/navigation"
import { requireIdentity } from "@agentonic/server/auth"
import { loadReviewListing } from "@agentonic/server/authoring"
import { PageHeader } from "@workspace/ui/components/page-header"
import { ReviewTable } from "@workspace/ui/components/review-table"
import {
  beginReview,
  changeReviewState,
  loadMember,
  revokeApproval,
} from "./actions"
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ workspace?: string }>
}) {
  const identity = await requireIdentity("admin")
  if (!identity.hasAccess) notFound()
  const { workspace } = await searchParams
  const listing = await loadReviewListing(workspace)
  if (!listing) throw new Error("No se pudo cargar la cola de revisión.")
  return (
    <>
      <PageHeader
        title="Revisiones"
        description="Consulta las versiones enviadas por los clientes y sigue sus revisiones por estado."
        count={listing.reviews.length}
      />
      <ReviewTable
        reviews={listing.reviews}
        workspaces={listing.workspaces}
        selectedWorkspace={workspace ?? "all"}
        now={new Date().toISOString()}
        openReview={beginReview}
        changeState={changeReviewState}
        loadMember={loadMember}
        revokeApproval={
          identity.staff &&
          ["administrator", "operator"].includes(identity.staff.role)
            ? revokeApproval
            : undefined
        }
      />
    </>
  )
}
