import { readFileSync } from "node:fs"
import { afterEach, beforeEach, expect, it } from "vitest"
import { reviewQueue } from "../packages/contracts/src/authoring"
import {
  operationsAgent,
  operationsUser,
} from "../packages/contracts/src/operations"
import {
  collection,
  createRagFixture,
  id,
  member,
  staff,
  w,
} from "../scripts/rag-benchmark/fixture"

// Approving a version closes the open reviews of older versions of the same
// agent as "Reemplazada" (migration 67). Approval itself has its own tests;
// here a direct approval row stands in for it, and the status change that
// every approval path makes fires the rule.
let f: Awaited<ReturnType<typeof createRagFixture>>
const agent = id(20)
const code = id(40)
beforeEach(async () => {
  f = await createRagFixture()
  // The Auth bridge Revisiones uses for the submitter's email.
  await f.sql(
    "ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN email_confirmed_at timestamptz, ADD COLUMN deleted_at timestamptz"
  )
  await f.db.exec(
    readFileSync("scripts/sql/review-identity-boundary.sql", "utf8")
  )
})
afterEach(async () => {
  await f.db.close()
})

// Prepares and sends version `n` (draft revision n) for review.
async function propose(n: number) {
  await f.actor()
  expect(
    (
      await f.command("draft.save", {
        agentId: agent,
        revision: n - 1,
        content: {
          version: 1,
          systemPrompt: `Synthetic instructions, version ${n}.`,
          skills: [],
        },
        requestedAccess: { version: 1, collectionIds: [collection], tools: [] },
      })
    ).ok
  ).toBe(true)
  const frozen = await f.command("candidate.freeze", {
    agentId: agent,
    revision: n,
    codeReleaseId: code,
  })
  expect(frozen.ok).toBe(true)
  const sent = await f.command("submission.send", {
    candidateId: frozen.id,
    note: "Synthetic proposal",
    consent: true,
  })
  expect(sent.ok).toBe(true)
  return sent.id
}
async function raw(q: string, params: unknown[] = []) {
  await f.sql("SET session_replication_role=replica")
  try {
    return await f.db.query(q, params)
  } finally {
    await f.db.exec("SET session_replication_role=origin")
  }
}
let decisions = 0
// The approval row as the review flow writes it, then the status change with
// triggers on, as every approval path does.
async function approve(submission: string) {
  decisions += 1
  await raw(
    `INSERT INTO agentonic.submission_review_decisions(id,workspace_id,agent_id,submission_id,decision_number,decision,actor_staff_id,support_access_grant_id,approval_expires_at,approved_access_sha256,assessment_snapshot)
     VALUES($1,$2,$3,$4,1,'approved',$5,$6,clock_timestamp()+interval '1 day',repeat('a',64),'{}')`,
    [id(700 + decisions), w, agent, submission, staff, id(799)]
  )
  await f.sql(
    "UPDATE agentonic.agent_submissions SET status='approved' WHERE id=$1",
    [submission]
  )
}
async function statuses() {
  const r = await f.sql<{ id: string; status: string }>(
    "SELECT id,status FROM agentonic.agent_submissions WHERE agent_id=$1",
    [agent]
  )
  return Object.fromEntries(r.rows.map((row) => [row.id, row.status]))
}
async function openReview(submission: string) {
  await f.actor(staff, w, "agentonic_admin")
  return f.command("review.open", { submissionId: submission })
}

it("closes open reviews of older versions when a version is approved", async () => {
  const v1 = await propose(1)
  const v2 = await propose(2)
  const v3 = await propose(3)
  const v4 = await propose(4)
  const v5 = await propose(5)
  // v1 already has an outcome; v2 is being reviewed with access granted.
  await raw(
    "UPDATE agentonic.agent_submissions SET status='changes_requested' WHERE id=$1",
    [v1]
  )
  const grant = await openReview(v2)
  expect(grant.ok).toBe(true)
  await raw(
    "UPDATE agentonic.agent_submissions SET status='in_review' WHERE id=$1",
    [v2]
  )

  await approve(v4)
  expect(await statuses()).toEqual({
    [v1]: "changes_requested",
    [v2]: "superseded",
    [v3]: "superseded",
    [v4]: "approved",
    [v5]: "submitted",
  })
  const closed = await f.sql<{
    submission_id: string
    decision: string
    actor_policy_version: string
    actor_staff_id: string | null
    assessment_snapshot: unknown
  }>(
    "SELECT submission_id,decision,actor_policy_version,actor_staff_id,assessment_snapshot FROM agentonic.submission_review_decisions WHERE decision='superseded' ORDER BY submission_id"
  )
  expect(closed.rows).toEqual(
    [v2, v3].sort().map((submission) => ({
      submission_id: submission,
      decision: "superseded",
      actor_policy_version: "superseded-by-approval-v1",
      actor_staff_id: null,
      assessment_snapshot: { version: 1, supersededBy: v4 },
    }))
  )
  const grants = await f.sql<{ revoked: boolean }>(
    "SELECT revoked_at IS NOT NULL revoked FROM agentonic.support_access_grants WHERE scope->>'submissionId'=$1",
    [v2]
  )
  expect(grants.rows).toEqual([{ revoked: true }])

  // Closed for staff: it can no longer be opened.
  await f.db.exec("SAVEPOINT refused")
  const reopened = await openReview(v3).catch(() => ({ ok: false }))
  expect(reopened.ok).toBe(false)
  await f.db.exec("ROLLBACK TO SAVEPOINT refused")

  // The queue says so, and nothing in it can take a decision yet.
  await f.actor(staff, w, "agentonic_admin")
  const queue = reviewQueue.parse(
    (
      await f.db.query<{ result: unknown }>(
        "SELECT agentonic.review_queue() result"
      )
    ).rows[0]!.result
  )
  expect(
    Object.fromEntries(
      queue.map((row) => [
        row.id,
        [row.status, row.canOpen, row.canDecide] as const,
      ])
    )
  ).toEqual({
    [v1]: ["changes_requested", false, false],
    [v2]: ["superseded", false, false],
    [v3]: ["superseded", false, false],
    [v4]: ["approved", false, false],
    [v5]: ["submitted", true, false],
  })

  // Running it again closes nothing more.
  const again = await f.sql<{ closed: number }>(
    "SELECT agentonic.supersede_older_reviews($1) closed",
    [v4]
  )
  expect(again.rows[0]!.closed).toBe(0)
})

it("refuses a superseded decision the approval rule did not make", async () => {
  const v1 = await propose(1)
  const v2 = await propose(2)
  await approve(v1)
  // v2 is newer than the approved v1, so v1's approval cannot close it.
  for (const supersededBy of [v1, v2]) {
    await f.db.exec("SAVEPOINT forged")
    await expect(
      f.sql(
        `INSERT INTO agentonic.submission_review_decisions(workspace_id,agent_id,submission_id,decision_number,decision,actor_policy_version,assessment_snapshot)
         VALUES($1,$2,$3,1,'superseded','superseded-by-approval-v1',jsonb_build_object('version',1,'supersededBy',$4::text))`,
        [w, agent, v2, supersededBy]
      )
    ).rejects.toThrow()
    await f.db.exec("ROLLBACK TO SAVEPOINT forged")
  }
  expect((await statuses())[v2]).toBe("submitted")
})

it("names Google Drive among the latest version's capabilities", async () => {
  await propose(1)
  await raw(
    `UPDATE agentonic.configuration_releases SET requested_access_snapshot=requested_access_snapshot||'{"tools":[{"driveConnectionId":"${id(90)}","operations":["read"]},{"capability":"web"}]}'::jsonb WHERE agent_id=$1`,
    [agent]
  )
  await f.actor(staff, w, "agentonic_admin")
  const page = operationsAgent.parse(
    (
      await f.db.query<{ result: unknown }>(
        "SELECT agentonic.operations_agent($1) result",
        [agent]
      )
    ).rows[0]!.result
  )
  expect(page.tools).toEqual({
    gmail: false,
    drive: true,
    web: true,
    collections: 1,
  })
})

it("reads a member's card for staff only", async () => {
  await f.sql(
    "UPDATE auth.users SET email='owner@example.invalid',email_confirmed_at=clock_timestamp() WHERE id=$1",
    [id(1)]
  )
  await propose(1)
  await propose(2)
  await f.actor(staff, w, "agentonic_admin")
  const card = operationsUser.parse(
    (
      await f.db.query<{ result: unknown }>(
        "SELECT agentonic.operations_user($1) result",
        [id(1)]
      )
    ).rows[0]!.result
  )
  expect(card).toMatchObject({
    id: id(1),
    name: "Owner",
    email: "owner@example.invalid",
    memberships: [
      {
        workspaceId: w,
        workspaceName: "A",
        role: "owner",
        status: "active",
        agents: 1,
        reviews: 2,
      },
    ],
  })
  expect(member).toBe(id(101))
  expect(
    (
      await f.db.query<{ result: unknown }>(
        "SELECT agentonic.operations_user($1) result",
        [id(999)]
      )
    ).rows[0]!.result
  ).toBeNull()

  await f.actor()
  await f.db.exec("SAVEPOINT refused")
  await expect(
    f.db.query("SELECT agentonic.operations_user($1)", [id(1)])
  ).rejects.toThrow()
  await f.db.exec("ROLLBACK TO SAVEPOINT refused")
})
