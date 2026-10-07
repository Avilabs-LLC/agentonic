import { afterEach, beforeEach, expect, it } from "vitest"
import { agentVersionSummary } from "../packages/contracts/src/agent-versions"
import {
  agentListing,
  type AgentListing,
} from "../packages/contracts/src/authoring"
import {
  operationsAgent,
  operationsAgents,
  operationsDeployments,
} from "../packages/contracts/src/operations"
import {
  collection,
  createRagFixture,
  id,
  member,
  staff,
  w,
} from "../scripts/rag-benchmark/fixture"

// What is in use and what comes next (migration 50). Authorization, liveness
// and approval validity have their own tests; here they are stand-ins driven
// by plain columns so each case sets exactly the fact it needs.
let f: Awaited<ReturnType<typeof createRagFixture>>
const agent = id(20)
const code = id(40)
beforeEach(async () => {
  f = await createRagFixture()
  await f.db.exec(`RESET ROLE;
CREATE OR REPLACE FUNCTION agentonic.deployment_authorized(d agentonic.deployments) RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$ SELECT d.revoked_at IS NULL $$;
CREATE OR REPLACE FUNCTION agentonic.deployment_online(d agentonic.deployments) RETURNS boolean LANGUAGE sql STABLE SET search_path='' AS $$ SELECT d.heartbeat_at IS NOT NULL $$;
CREATE OR REPLACE FUNCTION agentonic.approval_reason(decision_id uuid) RETURNS text LANGUAGE sql STABLE SET search_path='' AS $$
 SELECT CASE WHEN approval_expires_at>clock_timestamp() THEN 'valid' ELSE 'expired' END FROM agentonic.submission_review_decisions WHERE id=decision_id $$;`)
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
// Direct rows stand in for the review and deployment flows.
async function raw(q: string, params: unknown[] = []) {
  await f.sql("SET session_replication_role=replica")
  try {
    return await f.db.query(q, params)
  } finally {
    await f.db.exec("SET session_replication_role=origin")
  }
}
const status = (submission: string, value: string) =>
  raw("UPDATE agentonic.agent_submissions SET status=$2 WHERE id=$1", [
    submission,
    value,
  ])
let decisions = 0
async function approve(submission: string, valid = true) {
  await status(submission, "approved")
  decisions += 1
  await raw(
    `INSERT INTO agentonic.submission_review_decisions(id,workspace_id,agent_id,submission_id,decision_number,decision,actor_staff_id,support_access_grant_id,approval_expires_at,approved_access_sha256,assessment_snapshot,created_at)
     VALUES($1,$2,$3,$4,1,'approved',$5,$6,clock_timestamp()+$7::interval,repeat('a',64),'{}',clock_timestamp()-interval '2 days')`,
    [
      id(700 + decisions),
      w,
      agent,
      submission,
      staff,
      id(799),
      valid ? "1 day" : "-1 day",
    ]
  )
  return id(700 + decisions)
}
let deployments = 0
async function deploy(
  submission: string,
  approval: string,
  fields: { status: string; online?: boolean; authorized?: boolean }
) {
  deployments += 1
  const deployment = id(800 + deployments)
  await raw(
    `INSERT INTO agentonic.deployments(id,workspace_id,agent_id,code_release_id,configuration_release_id,submission_id,approval_id,host_id,environment,authorized_by_member_id,request_id,status,budget_usd,evidence_sources,authorized_until,heartbeat_at,revoked_at)
     SELECT $1,s.workspace_id,s.agent_id,s.code_release_id,s.configuration_release_id,s.id,$3,$4,'azure_staging',$5,$1,$6,0.25,'[]',clock_timestamp()+interval '6 days',$7,$8
     FROM agentonic.agent_submissions s WHERE s.id=$2`,
    [
      deployment,
      submission,
      approval,
      id(899),
      member,
      fields.status,
      fields.online === false ? null : new Date().toISOString(),
      fields.authorized === false ? new Date().toISOString() : null,
    ]
  )
  return deployment
}
async function summary() {
  const r = await f.sql<{ result: unknown }>(
    "SELECT agentonic.agent_version_summary($1) result",
    [agent]
  )
  return agentVersionSummary.parse(r.rows[0]!.result)
}

it("starts with nothing in use and nothing proposed", async () => {
  expect(await summary()).toEqual({
    archived: false,
    live: [],
    ended: null,
    next: null,
  })
})

it("follows a version from review to approval, activation and use", async () => {
  const v1 = await propose(1)
  expect((await summary()).next).toMatchObject({
    submissionId: v1,
    versionNumber: 1,
    status: "submitted",
    approvalReason: null,
    deployment: null,
  })
  const approval = await approve(v1)
  expect((await summary()).next).toMatchObject({
    status: "approved",
    approvalReason: "valid",
  })
  const pending = await deploy(v1, approval, { status: "awaiting_activation" })
  expect((await summary()).next?.deployment).toEqual({
    environment: "azure_staging",
    status: "awaiting_activation",
  })
  await raw("UPDATE agentonic.deployments SET status='running' WHERE id=$1", [
    pending,
  ])
  expect(await summary()).toEqual({
    archived: false,
    live: [
      {
        environment: "azure_staging",
        status: "running",
        resting: false,
        versionNumber: 1,
        submissionId: v1,
      },
    ],
    ended: null,
    next: null,
  })
})

it("shows a newer proposal beside the version in use", async () => {
  const v1 = await propose(1)
  await deploy(v1, await approve(v1), { status: "running" })
  const v2 = await propose(2)
  await status(v2, "in_review")
  const s = await summary()
  expect(s.live.map((l) => [l.versionNumber, l.status])).toEqual([
    [1, "running"],
  ])
  expect(s.next).toMatchObject({
    submissionId: v2,
    versionNumber: 2,
    status: "in_review",
  })
})

it("reports an offline or unauthorized version in use from observed facts", async () => {
  const v1 = await propose(1)
  const approval = await approve(v1)
  const d = await deploy(v1, approval, { status: "running", online: false })
  expect((await summary()).live[0]?.status).toBe("offline")
  await raw(
    "UPDATE agentonic.deployments SET revoked_at=clock_timestamp() WHERE id=$1",
    [d]
  )
  expect((await summary()).live[0]?.status).toBe("unauthorized")
})

it("keeps the last stopped deployment and offers the version again", async () => {
  const v1 = await propose(1)
  const approval = await approve(v1, false)
  await deploy(v1, approval, { status: "stopped" })
  const s = await summary()
  expect(s.live).toEqual([])
  expect(s.ended).toEqual({
    environment: "azure_staging",
    status: "stopped",
    versionNumber: 1,
  })
  expect(s.next).toMatchObject({
    submissionId: v1,
    status: "approved",
    approvalReason: "expired",
  })
})

it("skips withdrawn proposals and reports archived agents", async () => {
  const v1 = await propose(1)
  await approve(v1)
  const v2 = await propose(2)
  await status(v2, "withdrawn")
  expect((await summary()).next?.submissionId).toBe(v1)
  await raw(
    "UPDATE agentonic.agents SET archived_at=clock_timestamp() WHERE id=$1",
    [agent]
  )
  expect((await summary()).archived).toBe(true)
})

it("gives staff the agent page and editors the summary, as metadata only", async () => {
  const v1 = await propose(1)
  await deploy(v1, await approve(v1), { status: "running" })
  await f.actor(staff, w, "agentonic_admin")
  const page = operationsAgent.parse(
    (
      await f.db.query<{ result: unknown }>(
        "SELECT agentonic.operations_agent($1) result",
        [agent]
      )
    ).rows[0]!.result
  )
  expect(page).toMatchObject({
    id: agent,
    name: "Synthetic agent",
    workspaceId: w,
    latestVersion: 1,
    proposals: [
      { id: v1, versionNumber: 1, status: "approved", approvalReason: "valid" },
    ],
    deployments: [{ status: "running", versionNumber: 1 }],
    activity: { runs7d: 0, failed7d: 0, knownUsd30d: 0 },
  })
  expect(JSON.stringify(page)).not.toContain("Synthetic instructions")
  const listed = operationsAgents.parse(
    (
      await f.db.query<{ result: unknown }>(
        "SELECT agentonic.operations_agents() result"
      )
    ).rows[0]!.result
  )
  expect(listed[0]?.summary.live[0]?.status).toBe("running")
  // The human-readable version, not the internal release label.
  expect(listed[0]?.latestVersion).toBe("1")
  // Despliegues shows each deployment's version too (migration 53).
  const deployments = operationsDeployments.parse(
    (
      await f.db.query<{ result: unknown }>(
        "SELECT agentonic.operations_deployments() result"
      )
    ).rows[0]!.result
  )
  expect(deployments.deployments).toEqual([
    expect.objectContaining({ agentId: agent, versionNumber: 1 }),
  ])
  expect(
    (
      await f.db.query<{ result: unknown }>(
        "SELECT agentonic.operations_agent($1) result",
        [id(21)]
      )
    ).rows[0]!.result
  ).toBeNull()

  await f.actor()
  const customer: AgentListing = agentListing.parse(
    (
      await f.db.query<{ result: unknown }>(
        "SELECT agentonic.agent_listing() result"
      )
    ).rows[0]!.result
  )
  expect(customer[0]?.configuration?.summary?.live[0]?.versionNumber).toBe(1)
  await f.db.exec("SAVEPOINT refused")
  await expect(
    f.db.query("SELECT agentonic.operations_agent($1)", [agent])
  ).rejects.toThrow()
  await f.db.exec("ROLLBACK TO SAVEPOINT refused")
})
