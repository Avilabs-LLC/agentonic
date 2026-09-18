import { gmailGrants, hasWeb } from "@agentonic/contracts/tools"
import "server-only"
import { randomUUID } from "node:crypto"
import {
  authoringCommand,
  agentListing,
  editableDraftContent,
  authoringResult,
  workspaceView,
  agentView,
  reviewQueue,
  type ReviewListing,
  reviewView,
  type AuthoringCommand,
} from "@agentonic/contracts/authoring"
import { uuid, type AppKind } from "@agentonic/contracts/identity"
import { withIdentity } from "@agentonic/database/client"
import { requireIdentity, requireVerifiedUser } from "./auth"
import { defaultFreezeCode } from "@agentonic/contracts/workflow"
import { latestCreationTemplate } from "./catalog"
export async function runAuthoringCommand(app: AppKind, input: unknown) {
  const parsed = authoringCommand.safeParse(input)
  if (
    !parsed.success ||
    (parsed.data.operation.startsWith("review.") && app !== "admin")
  )
    return { ok: false as const }
  const actor = await requireVerifiedUser(app)
  try {
    return await withIdentity(
      actor.authId,
      parsed.data.workspaceId,
      async (tx) => {
        const result = await tx.$queryRaw<
          { result: unknown }[]
        >`SELECT agentonic.authoring_command(${parsed.data.operation}::text,${JSON.stringify(parsed.data.payload)}::jsonb,${randomUUID()}::uuid) result`
        const response = authoringResult.parse(result[0]?.result)
        if (parsed.data.operation === "list" && response.ok) {
          const view = workspaceView.parse(response.data)
          return {
            ...response,
            data: {
              ...view,
              creationAvailable: !!(await latestCreationTemplate(tx)),
            },
          }
        }
        if (parsed.data.operation !== "detail" || !response.ok) return response
        const view = agentView.parse(response.data)
        // Reuse the detail transaction's workspace read lock and RLS context.
        // Eligibility comes from each immutable snapshot, not the current form.
        const candidates = await tx.$queryRaw<
          {
            id: string
            codeReleaseId: string
            eligible: boolean
            previewAvailable: boolean
            content: unknown
            number: number
            createdAt: string
          }[]
        >`
          SELECT r.id, r.code_release_id AS "codeReleaseId", r.content,
            (row_number() OVER (ORDER BY r.created_at, r.id))::integer AS number,
            r.created_at::text AS "createdAt",
            (r.retired_at IS NULL AND agentonic.can_use_code(r.code_release_id) AND EXISTS(SELECT 1 FROM agentonic.code_releases c WHERE c.id=r.code_release_id AND c.execution_manifest->>'previewContract'='1')) AS "previewAvailable",
            (r.retired_at IS NULL AND agentonic.can_use_code(r.code_release_id)
             AND NOT EXISTS (SELECT 1 FROM agentonic.agent_submissions s WHERE s.workspace_id=r.workspace_id AND s.configuration_release_id=r.id)
             AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(r.requested_access_snapshot->'collectionIds') c(id) WHERE NOT agentonic.can_collection(c.id::uuid,'read'))) AS eligible
          FROM agentonic.configuration_releases r
          WHERE r.workspace_id=${parsed.data.workspaceId}::uuid AND r.agent_id=${parsed.data.payload.agentId}::uuid`
        const activePreviews =
          app === "customer"
            ? await tx.$queryRaw<{ candidateId: string; expiresAt: string }[]>`
              SELECT candidate_id AS "candidateId", expires_at::text AS "expiresAt"
              FROM agentonic.active_agent_previews(${parsed.data.payload.agentId}::uuid)`
            : []
        const details = new Map(
          candidates.map((candidate) => [candidate.id, candidate])
        )
        const codes = await tx.$queryRaw<{ id: string; research: boolean }[]>`
          SELECT id, coalesce(execution_manifest->>'webResearch'='1',false) AS research FROM agentonic.code_releases
          WHERE template_version_id=${view.agent.templateVersionId}::uuid
            AND retired_at IS NULL AND agentonic.can_use_code(id)
            AND execution_manifest->>'previewContract'='1'
            AND (${gmailGrants(view.draft.requestedAccess.tools).length === 0} OR execution_manifest->>'gmailContract'='1')
            AND (${!hasWeb(view.draft.requestedAccess.tools)} OR execution_manifest->>'webContract'='1')
          ORDER BY created_at DESC, id DESC`
        const enriched = view.candidates.map((candidate) => ({
          ...candidate,
          codeReleaseId: details.get(candidate.id)?.codeReleaseId ?? null,
        }))
        return {
          ...response,
          data: {
            ...view,
            preparationCodeReleaseId:
              defaultFreezeCode(
                enriched,
                codes.map((code) => code.id),
                hasWeb(view.draft.requestedAccess.tools)
                  ? codes.filter((code) => code.research).map((code) => code.id)
                  : []
              ) || null,
            candidates: view.candidates.map((candidate) => {
              const detail = details.get(candidate.id)
              return {
                ...candidate,
                codeReleaseId: detail?.codeReleaseId ?? null,
                number: detail?.number,
                createdAt: detail?.createdAt,
                canPreview: !!detail?.previewAvailable,
                previewExpiresAt:
                  activePreviews.find((p) => p.candidateId === candidate.id)
                    ?.expiresAt ?? null,
                canSubmit:
                  !!detail?.eligible &&
                  editableDraftContent.safeParse(detail.content).success,
              }
            }),
          },
        }
      },
      actor.email
    )
  } catch {
    return { ok: false as const }
  }
}
export async function loadWorkspace(workspaceId: string) {
  const r = await runAuthoringCommand("customer", {
    operation: "list",
    workspaceId,
    payload: {},
  })
  if (!r.ok) return null
  const result = workspaceView.safeParse(r.data)
  return result.success ? result.data : null
}
export async function loadAgent(workspaceId: string, agentId: string) {
  const r = await runAuthoringCommand("customer", {
    operation: "detail",
    workspaceId,
    payload: { agentId },
  })
  if (!r.ok) return null
  const result = agentView.safeParse(r.data)
  return result.success ? result.data : null
}
export async function loadReviewQueue(workspaceId: string) {
  if (!uuid.safeParse(workspaceId).success) return null
  const actor = await requireVerifiedUser("admin")
  try {
    return await withIdentity(actor.authId, workspaceId, async (tx) => {
      const rows = await tx.$queryRaw<{ result: unknown }[]>`
        SELECT agentonic.review_queue() result`
      return reviewQueue.parse(rows[0]?.result)
    })
  } catch {
    return null
  }
}
export async function openReview(
  workspaceId: string,
  submissionId: string,
  grantId: string
) {
  const r = await runAuthoringCommand("admin", {
    operation: "review.read",
    workspaceId,
    payload: { submissionId, grantId },
  })
  if (!r.ok) return null
  const result = reviewView.safeParse(r.data)
  return result.success ? result.data : null
}
export async function reviewWorkspaces() {
  const actor = await requireVerifiedUser("admin")
  try {
    return await withIdentity(actor.authId, null, async (tx) => {
      const rows = await tx.$queryRaw<
        { id: string; name: string }[]
      >`SELECT * FROM agentonic.review_workspaces()`
      return rows.filter((row) => uuid.safeParse(row.id).success)
    })
  } catch {
    return null
  }
}
// Discover scope server-side, then retain an isolated verified transaction for
// every workspace. A failed read must not silently produce a partial queue.
export async function loadReviewListing(workspaceId?: string) {
  if (workspaceId !== undefined && !uuid.safeParse(workspaceId).success)
    return null
  const workspaces = await reviewWorkspaces()
  if (!workspaces) return null
  if (
    workspaceId &&
    !workspaces.some((workspace) => workspace.id === workspaceId)
  )
    return null
  const selected = workspaceId
    ? workspaces.filter((workspace) => workspace.id === workspaceId)
    : workspaces
  const reviews: ReviewListing = []
  for (const workspace of selected) {
    const queue = await loadReviewQueue(workspace.id)
    if (!queue) return null
    reviews.push(
      ...queue.map((review) => ({
        ...review,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
      }))
    )
  }
  return { workspaces, reviews }
}

export type CustomerAuthoringCommand = Exclude<
  AuthoringCommand,
  { operation: `review.${string}` }
>

export async function loadAgentListing(workspaceId: string) {
  const actor = await requireVerifiedUser("customer")
  return withIdentity(
    actor.authId,
    workspaceId,
    async (tx) => {
      const rows = await tx.$queryRaw<
        { result: unknown }[]
      >`SELECT agentonic.agent_listing() result`
      return agentListing.parse(rows[0]?.result)
    },
    actor.email
  )
}

export async function loadCustomerAgentListing(workspace?: string | string[]) {
  const identity = await requireIdentity("customer")
  const selectedWorkspaceIds = [
    ...new Set(
      workspace === undefined
        ? []
        : Array.isArray(workspace)
          ? workspace
          : [workspace]
    ),
  ]
  if (
    !identity.hasAccess ||
    selectedWorkspaceIds.some(
      (id) => !identity.workspaces.some((item) => item.id === id)
    )
  )
    return null
  const selectedWorkspaces = identity.workspaces.filter(
    (item) =>
      !selectedWorkspaceIds.length || selectedWorkspaceIds.includes(item.id)
  )
  // Every read retains its own verified transaction-local tenant context.
  // A failed read rejects the complete listing instead of hiding missing rows.
  const listings = await Promise.all(
    selectedWorkspaces.map(async (item) =>
      (await loadAgentListing(item.id)).map((agent) => ({
        ...agent,
        workspaceId: item.id,
        workspaceName: item.name,
      }))
    )
  )
  return {
    agents: listings.flat(),
    workspaces: identity.workspaces,
    selectedWorkspaces,
    selectedWorkspaceIds,
  }
}
