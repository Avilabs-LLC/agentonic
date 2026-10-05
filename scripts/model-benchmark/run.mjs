import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import {
  cases,
  results as searchResults,
  page as pageResponse,
} from "./cases.ts"
const publicWeb = process.argv.includes("--public")
const reportPath = publicWeb
  ? ".local/web/model-comparison-public.json"
  : ".local/web/model-comparison.json"
const selectedCases = publicWeb
  ? [
      {
        ...cases[0],
        name: "madrid-public",
        expected: "manual public-source verification",
      },
    ]
  : cases
const models = ["gpt-4.1-mini-2025-04-14", "gpt-6-astra"]
if (!process.argv.includes("--live"))
  throw new Error("Use --live to run the metered synthetic model benchmark")
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs"
mkdirSync(".local/web", { recursive: true })
import { randomUUID } from "node:crypto"
import { loadLocal, connect, bootstrapConfig } from "../local-config.mjs"
import { runPreview } from "../../apps/worker/src/runtime.ts"
import { directProviders } from "../../apps/worker/src/providers.ts"
const env = loadLocal(".env.database.local"),
  worker = loadLocal("apps/worker/.env.local")
let db, customer, broker, agentId, previewId, job
const originalFetch = globalThis.fetch
let modelCalls = 0,
  webCalls = 0
const report =
  process.argv.includes("--resume") && existsSync(reportPath)
    ? JSON.parse(readFileSync(reportPath, "utf8"))
    : []
try {
  assert.equal(bootstrapConfig().ref, "jkgdxkacariasunhentd")
  db = await connect(
    env.AGENTONIC_MIGRATION_DATABASE_URL,
    env.AGENTONIC_DATABASE_CA_FILE
  )
  customer = await connect(
    env.AGENTONIC_CUSTOMER_DATABASE_URL,
    env.AGENTONIC_DATABASE_CA_FILE
  )
  broker = await connect(worker.DATABASE_URL, worker.AGENTONIC_DATABASE_CA_FILE)
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM agentonic.background_jobs WHERE status IN ('running','queued')"
      )
    ).rows[0].n,
    0
  )
  const owner = (
    await db.query(
      "SELECT u.auth_user_id,m.workspace_id FROM agentonic.users u JOIN agentonic.workspace_members m ON m.user_id=u.id JOIN agentonic.workspaces w ON w.id=m.workspace_id WHERE w.slug='bootstrap-customer-a' AND m.role='owner' AND m.status='active' AND m.removed_at IS NULL"
    )
  ).rows[0]
  assert.ok(owner)
  async function command(operation, payload, fn = "authoring_command") {
    await customer.query("BEGIN")
    try {
      await customer.query(
        "SELECT set_config('agentonic.auth_user_id',$1,true),set_config('agentonic.workspace_id',$2,true)",
        [owner.auth_user_id, owner.workspace_id]
      )
      const args = [operation, JSON.stringify(payload)]
      if (fn !== "preview_command") args.push(randomUUID())
      const r = (
        await customer.query(
          `SELECT agentonic.${fn}($1,$2::jsonb${fn === "preview_command" ? "" : ",$3::uuid"}) result`,
          args
        )
      ).rows[0].result
      await customer.query("COMMIT")
      if (!r.ok && operation === "start" && r.code === "rate_limit") {
        await delay(22000)
        return command(operation, payload, fn)
      }
      assert.equal(r.ok, true, "Command rejected: " + operation + ":" + r.code)
      return r
    } catch (e) {
      await customer.query("ROLLBACK")
      throw e
    }
  }
  const release = (
    await db.query(
      "SELECT id,template_version_id,execution_manifest,artifact_sha256,git_commit_sha FROM agentonic.code_releases WHERE execution_manifest->>'webResearch'='1' AND revoked_at IS NULL AND retired_at IS NULL ORDER BY created_at DESC LIMIT 1"
    )
  ).rows[0]
  assert.ok(release)
  agentId = (
    await command(
      "agent.create",
      {
        name: "Synthetic model comparison",
        slug: `web-check-${randomUUID()}`,
        templateVersionId: release.template_version_id,
      },
      "access_command"
    )
  ).id
  await command("draft.save", {
    agentId,
    revision: 0,
    content: {
      version: 1,
      systemPrompt:
        "You are a research assistant. Help the user find options meeting all their requirements.",
      skills: [],
    },
    requestedAccess: {
      version: 1,
      collectionIds: [],
      tools: [{ capability: "web", operations: ["web.search", "web.read"] }],
    },
  })
  const candidate = (
    await command("candidate.freeze", {
      agentId,
      revision: 1,
      codeReleaseId: release.id,
    })
  ).id
  const execute = async (op, j, p = {}) =>
    (
      await broker.query(
        `SELECT agentonic.${op.startsWith("web-") ? "web_preview_worker" : "rag_worker"}($1,$2::uuid,$3::uuid,$4::jsonb) result`,
        [op, j.id, j.token, JSON.stringify(p)]
      )
    ).rows[0].result
  let lastStart = 0
  for (const fixture of selectedCases)
    for (const model of models) {
      if (
        report.some(
          (item) => item.name === fixture.name && item.model === model
        )
      )
        continue
      await delay(Math.max(0, 22000 - (Date.now() - lastStart)))
      lastStart = Date.now()
      previewId = (
        await command(
          "start",
          { agentId, candidateId: candidate, enableTools: true, budgetUsd: 3 },
          "preview_command"
        )
      ).id
      const read = []
      let failedReads = 0,
        searches = 0
      const startedAt = Date.now()
      const publicEvidence = []
      modelCalls = 0
      webCalls = 0
      if (fixture.history) {
        const queued = (
          await command(
            "turn",
            {
              agentId,
              previewId,
              query: fixture.history.query,
              requestKey: randomUUID(),
            },
            "preview_command"
          )
        ).id
        job = (await broker.query("SELECT agentonic.rag_claim(false) result"))
          .rows[0].result
        assert.equal(job.id, queued)
        await execute("empty-search", job)
        await execute("answer", job, {
          text: fixture.history.answer,
          citations: [],
          insufficientEvidence: true,
          model: "gpt-4.1-mini-2025-04-14",
        })
      }
      const queued = (
        await command(
          "turn",
          {
            agentId,
            previewId,
            query: fixture.query,
            model,
            requestKey: randomUUID(),
          },
          "preview_command"
        )
      ).id
      job = (await broker.query("SELECT agentonic.rag_claim(false) result"))
        .rows[0].result
      assert.equal(job.id, queued)
      await execute("empty-search", job)
      globalThis.fetch = async (url, opts) => {
        const host = new URL(String(url)).hostname
        if (host === "api.openai.com") {
          modelCalls++
          return originalFetch(url, opts)
        }
        assert.equal(host, "api.browserbase.com")
        webCalls++
        const args = JSON.parse(String(opts.body))
        if (publicWeb) {
          const response = await originalFetch(url, opts)
          const captured = await response
            .clone()
            .json()
            .catch(() => null)
          publicEvidence.push({
            operation: args.query ? "search" : "read",
            args,
            status: response.status,
            result: captured,
          })
          writeFileSync(
            `.local/web/public-evidence-${model}.json`,
            JSON.stringify(publicEvidence, null, 2),
            { mode: 0o600 }
          )
          if (args.query) searches++
          if (!args.query && response.ok && captured?.statusCode === 200)
            read.push(args.url)
          if (!response.ok || captured?.statusCode >= 300) failedReads++
          return response
        }
        const data = args.query
          ? searchResults(
              fixture.results[Math.min(searches++, fixture.results.length - 1)]
            )
          : pageResponse(args.url, fixture.pages)
        if (data.statusCode === 200) read.push(args.url)
        if (data.statusCode >= 300) failedReads++
        return new globalThis.Response(JSON.stringify(data), {
          headers: { "content-type": "application/json" },
        })
      }
      await runPreview(
        job,
        execute,
        {
          gitCommit: release.git_commit_sha,
          artifactSha256: release.artifact_sha256,
          manifest: release.execution_manifest,
        },
        process.cwd() + "/.local/runtime",
        directProviders({
          openaiKey: worker.OPENAI_API_KEY,
          browserbaseKey: publicWeb
            ? worker.BROWSERBASE_API_KEY
            : "synthetic-provider",
        }),
        new globalThis.AbortController().signal
      )
      const state = await command(
        "state",
        { agentId, previewId },
        "preview_command"
      )
      const answer = state.turns.at(-1).answer
      const item = {
        name: fixture.name,
        model,
        expected: fixture.expected,
        failedReads,
        searches,
        modelCalls,
        webCalls,
        read,
        durationMs: Date.now() - startedAt,
        committedMicrousd: state.committedMicrousd,
        recordedModel: answer.model,
        text: answer.text,
        review: "pending independent manual assessment",
      }
      assert.equal(answer.model, model)
      if (publicWeb)
        writeFileSync(
          `.local/web/public-evidence-${model}.json`,
          JSON.stringify(publicEvidence, null, 2),
          { mode: 0o600 }
        )
      report.push(item)
      writeFileSync(reportPath, JSON.stringify(report, null, 2), {
        mode: 0o600,
      })
      console.log(JSON.stringify({ ...item, text: undefined, read: undefined }))
      // Close only this synthetic session; never reset its provider reservations.
      await command("cancel", { agentId, previewId }, "preview_command")
    }
  writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 })
} catch (e) {
  console.log(
    JSON.stringify({
      passed: false,
      modelCalls,
      webCalls,
      diagnostic:
        e.diagnostic ??
        (["runtime_mismatch", "provider_unavailable"].includes(e.message)
          ? e.message
          : (e.code ?? "verification_failed")),
    })
  )
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  if (db && agentId) {
    try {
      await db.query("BEGIN")
      for (const sql of [
        "DELETE FROM agentonic.background_jobs WHERE preview_id IN (SELECT id FROM agentonic.agent_previews WHERE agent_id=$1)",
        "DELETE FROM agentonic.agent_previews WHERE agent_id=$1",
        "DELETE FROM agentonic.configuration_tools WHERE agent_id=$1",
        "DELETE FROM agentonic.configuration_releases WHERE agent_id=$1",
        "DELETE FROM agentonic.configuration_drafts WHERE agent_id=$1",
        "DELETE FROM agentonic.agents WHERE id=$1",
      ])
        await db.query(sql, [agentId])
      await db.query("COMMIT")
      console.log("Synthetic fixture removed; provider usage retained.")
    } catch {
      await db.query("ROLLBACK")
      writeFileSync(
        ".local/web/model-comparison-cleanup.json",
        JSON.stringify({ agentId, previewId }),
        { mode: 0o600 }
      )
      console.log("Synthetic cleanup pending.")
    }
  }
  await broker?.end()
  await customer?.end()
  await db?.end()
}
