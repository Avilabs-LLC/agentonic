import "server-only"
import { withIdentity } from "@agentonic/database/client"
import { expiryRows, runtimeRegistrations } from "@agentonic/contracts/expiry"
import { requireVerifiedUser } from "./auth"
import { loadReviewListing } from "./authoring"

export async function loadRuntimeRegistrations() {
  const actor = await requireVerifiedUser("admin")
  try {
    return await withIdentity(actor.authId, null, async (tx) => {
      const rows = await tx.$queryRaw<
        { result: unknown }[]
      >`SELECT agentonic.runtime_registrations() result`
      return runtimeRegistrations.parse(rows[0]?.result)
    })
  } catch {
    return null
  }
}

// Every workspace is read in its own verified transaction (loadReviewListing);
// a failed read fails the whole overview rather than hiding a deadline.
export async function loadExpiryOverview() {
  const [registrations, listing] = await Promise.all([
    loadRuntimeRegistrations(),
    loadReviewListing(),
  ])
  if (!registrations || !listing) return null
  const now = new Date()
  return {
    now: now.toISOString(),
    registrations,
    rows: expiryRows(listing.reviews, registrations, now),
  }
}
