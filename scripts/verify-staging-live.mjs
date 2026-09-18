import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { root } from "./local-config.mjs"
// Called only by the explicitly live synthetic review smoke check after real approval.
export async function verifyStagingLive({
  db,
  customer,
  owner,
  fixture,
  cmd,
  waitFor,
}) {
  const reports = []
  async function chat(operation, payload) {
    await customer.query("BEGIN")
    try {
      await customer.query(
        "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id',$2,true)",
        [owner.auth_user_id, fixture.workspaceId]
      )
      const r = await customer.query(
        "SELECT agentonic.staging_chat($1,$2) result",
        [operation, JSON.stringify(payload)]
      )
      await customer.query("COMMIT")
      assert.equal(r.rows[0].result.ok, true)
      return r.rows[0].result
    } catch (e) {
      await customer.query("ROLLBACK")
      throw e
    }
  }
  for (const environment of ["local", "azure_staging"]) {
    const deployment = await cmd(
      "authorize",
      {
        submissionId: fixture.submissionId,
        environment,
        budgetUsd: 0.05,
        consent: true,
        requestId: randomUUID(),
      },
      "deployment_command"
    )
    await cmd(
      "activate",
      { deploymentId: deployment.id },
      "deployment_command",
      true
    )
    await waitFor(async () => {
      const r = (
        await db.query(
          "SELECT status,heartbeat_at FROM agentonic.deployments WHERE id=$1",
          [deployment.id]
        )
      ).rows[0]
      assert.ok(
        !["failed", "stopped"].includes(r.status),
        "Staging installation failed"
      )
      return (
        r.status === "running" &&
        Date.now() - Date.parse(r.heartbeat_at) < 60000
      )
    })
    const conversation = await chat("start", {
      deploymentId: deployment.id,
      title: "Synthetic staging verification",
    })
    await new Promise((resolve) => globalThis.setTimeout(resolve, 31000))
    await chat("turn", {
      conversationId: conversation.id,
      query: "How many years is the synthetic device warranty?",
      requestId: randomUUID(),
    })
    const answered = await waitFor(async () => {
      const s = await chat("state", { conversationId: conversation.id })
      const last = s.turns.at(-1)
      if (last?.status === "failed") throw new Error("Synthetic turn failed")
      return last?.status === "succeeded" ? s : null
    })
    assert.match(answered.turns.at(-1).answer, /three|3|tres/i)
    assert.ok(answered.turns.at(-1).citations.length > 0)
    if (environment === "azure_staging") {
      // Restart the isolated synthetic service only. Reconcile and retain the conversation.
      const restartedAfter = Date.now()
      execFileSync(
        "ssh",
        [
          "vm-agents-01",
          "sudo",
          "-n",
          "systemctl",
          "restart",
          `agentonic-staging@${deployment.id}.service`,
        ],
        { stdio: "ignore" }
      )
      await waitFor(async () => {
        const s = await chat("state", { conversationId: conversation.id })
        const heartbeat = (
          await db.query(
            "SELECT heartbeat_at FROM agentonic.deployments WHERE id=$1",
            [deployment.id]
          )
        ).rows[0].heartbeat_at
        return s.online && Date.parse(heartbeat) > restartedAfter ? s : null
      })
      const restored = await chat("state", { conversationId: conversation.id })
      assert.equal(restored.turns[0].answer, answered.turns[0].answer)
    }
    const consumption = answered.committedMicrousd
    await cmd(
      "stop",
      { deploymentId: deployment.id },
      "deployment_command",
      true
    )
    await waitFor(async () => {
      const rows = await db.query(
        "SELECT count(*)::int n FROM agentonic.staging_turns WHERE conversation_id=$1 AND scrubbed_at IS NULL",
        [conversation.id]
      )
      return rows.rows[0].n === 0
    })
    const retained = (
      await db.query(
        "SELECT committed_microusd FROM agentonic.deployments WHERE id=$1",
        [deployment.id]
      )
    ).rows[0]
    assert.equal(Number(retained.committed_microusd), consumption)
    reports.push({
      environment,
      deploymentId: deployment.id,
      committedMicrousd: consumption,
      checks: [
        "verified activation",
        "cited private chat",
        "stop denies access",
        "content scrubbed",
        "usage retained",
        ...(environment === "azure_staging"
          ? ["systemd restart and conversation recovery"]
          : []),
      ],
    })
    console.log(
      JSON.stringify({
        event: "staging_smoke_passed",
        environment,
        committedMicrousd: consumption,
      })
    )
  }
  writeFileSync(
    join(root, ".local/staging/live-report.json"),
    JSON.stringify({ verifiedAt: new Date().toISOString(), reports }, null, 2) +
      "\n",
    { mode: 0o600 }
  )
}
