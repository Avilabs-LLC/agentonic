import { createHash } from "node:crypto"
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { parse } from "dotenv"
import { createRagFixture, collection, id, w, member } from "./fixture"
import * as originalDataset from "./dataset"
import * as coverageDataset from "./coverage-dataset"
const { cases, documents, DATASET_VERSION } = process.argv.includes(
  "--original"
)
  ? originalDataset
  : coverageDataset
import { mean, percentile, retrievalMetrics } from "./metrics"
import { answer as generateAnswer } from "../../apps/worker/src/answer"
import { setTimeout as delay } from "node:timers/promises"
import { chunkPages } from "../../apps/worker/src/chunking"
import { embed, type Execute, type Lease } from "../../apps/worker/src/pipeline"
import {
  RETRIEVAL_PROFILE,
  RERANK_MODEL,
  rerankJob,
} from "../../apps/worker/src/reranking"

const live = process.argv.includes("--live")
const answers = process.argv.includes("--answers")
if (answers && !live) throw new Error("Answer evaluation requires --live")
const env = live
  ? {
      ...(existsSync("apps/worker/.env.local")
        ? parse(readFileSync("apps/worker/.env.local"))
        : {}),
      ...process.env,
    }
  : {}
if (live && (!env.VOYAGE_API_KEY || (answers && !env.OPENAI_API_KEY)))
  throw new Error("Provider configuration required; no credentials are printed")
const cap = 250_000 // $0.25 maximum reservations across both providers, per invocation.
const directory = `.local/rag-benchmark/${new Date().toISOString().replaceAll(":", "-")}`
mkdirSync(directory, { recursive: true, mode: 0o700 })
const journal: {
  id: string
  model: string
  reserved: number
  actual?: number
}[] = []
const persist = () =>
  writeFileSync(
    `${directory}/usage.json`,
    JSON.stringify({ capMicrousd: cap, operations: journal }, null, 2),
    { mode: 0o600 }
  )
const fixture = await createRagFixture()
const { db, actor, sql, upload, claim, worker, rag } = fixture
const signal = AbortSignal.timeout(1_200_000)
let lastVoyageRequest = 0
let pacingMs = 0
const execute: Execute = async (operation, job, payload = {}) => {
  if (operation === "reserve") {
    const committed = journal.reduce((n, r) => n + (r.actual ?? r.reserved), 0)
    if (committed + Number(payload.microusd) > cap) return { ok: false }
  }
  if (operation === "reserve" && payload.provider === "voyage") {
    // Pace the synthetic run for low-tier accounts (three requests/minute).
    const waitMs = Math.max(0, 21_000 - (Date.now() - lastVoyageRequest))
    pacingMs += waitMs
    await delay(waitMs, undefined, { signal })
    await worker(job, "heartbeat")
    lastVoyageRequest = Date.now()
  }
  const result = await worker(job, operation, payload)
  if (operation === "reserve" && result.ok) {
    journal.push({
      id: String(payload.id),
      model: String(payload.model),
      reserved: Number(payload.microusd),
    })
    persist()
  }
  if (operation === "settle") {
    const entry = journal.find((r) => r.id === payload.id)
    if (!entry) throw new Error("Missing reservation")
    entry.actual = Number(payload.microusd)
    persist()
  }
  return result
}
// Offline vectors exercise the SQL/metrics only; they are NOT semantic-quality evidence.
function diagnosticVector(text: string) {
  const vector = Array<number>(1024).fill(0)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    const hash = createHash("sha256").update(word).digest().readUInt32BE(0)
    vector[hash % 1024]! += 1
  }
  if (!vector.some(Boolean)) vector[0] = 1
  return vector
}
const canonical = (key: string) =>
  key === "duplicate" ? "aurora-warranty" : key
const chunkKeys = new Map<string, string>()
const excludedIds = new Set<string>()
type Row = {
  mode: string
  key: string
  split: string
  category: string
  ranked: string[]
  hit: number | null
  recall: number | null
  reciprocalRank: number | null
  ndcg: number | null
  latencyMs: number
  pacingMs: number
  candidateRecall: number | null
  baselineEvidenceRetained: boolean | null
  microusd: number
  duplicateCount: number
  deniedPassages: number
  abstained: boolean | null
  citationPrecision: number | null
  expectedFactsPresent: boolean | null
  unsupportedAnswer: boolean | null
}
const rows: Row[] = []
const answerAudit: {
  mode: string
  key: string
  text: string
  citations: string[]
  abstained: boolean
}[] = []
try {
  await sql("UPDATE agentonic.retrieval_provider_budgets SET cap_microusd=$1", [
    cap,
  ])
  const otherCollection = id(31)
  await sql(
    "INSERT INTO agentonic.knowledge_collections(id,workspace_id,name,slug,owner_member_id) VALUES($1,$2,'Synthetic private','synthetic-private',$3)",
    [otherCollection, w, member]
  )
  const corpusChunks = documents.map((document) =>
    chunkPages([{ text: document.text }])
  )
  const corpusVectors: number[][] = []
  const queryVectors: number[][] = []
  let corpusOffset = 0
  for (const [documentIndex, document] of documents.entries()) {
    const object = await upload(
      document.excluded === "unselected" ? otherCollection : collection
    )
    const job = (await claim()) as Lease
    const chunks = corpusChunks[documentIndex]!
    if (live && documentIndex === 0) {
      // Batch identical document/query inputs once so both modes use exactly the
      // same real embeddings. Meter against this isolated synthetic fixture job.
      for (const [texts, type, target] of [
        [corpusChunks.flat().map((c) => c.text), "document", corpusVectors],
        [cases.map((c) => c.query), "query", queryVectors],
      ] as const) {
        for (let start = 0; start < texts.length; start += 16) {
          target.push(
            ...(await embed(
              texts.slice(start, start + 16),
              type,
              job,
              execute,
              env.VOYAGE_API_KEY!,
              signal
            ))
          )
          console.log(
            `Embedded synthetic ${type} batch ${1 + Math.floor(start / 16)}`
          )
        }
      }
    }
    const vectors = live
      ? corpusVectors.slice(corpusOffset, corpusOffset + chunks.length)
      : chunks.map((c) => diagnosticVector(c.text))
    corpusOffset += chunks.length
    await worker(job, "publish", {
      parser: "text-v1",
      chunks: chunks.map((c, i) => ({ ...c, embedding: vectors[i] })),
    })
    const found = await sql(
      "SELECT ch.id, ch.ordinal, v.document_id FROM agentonic.document_chunks ch JOIN agentonic.document_versions v ON v.id=ch.document_version_id WHERE v.object_id=$1",
      [object]
    )
    for (const row of found.rows) {
      // Stable synthetic IDs make SQL tie-breaking repeatable across invocations.
      const suffix = createHash("sha256")
        .update(`${DATASET_VERSION}/${document.key}/${row.ordinal}`)
        .digest("hex")
        .slice(0, 12)
      const stableId = `20000000-0000-4000-8000-${suffix}`
      await sql("UPDATE agentonic.document_chunks SET id=$1 WHERE id=$2", [
        stableId,
        row.id,
      ])
      chunkKeys.set(stableId, canonical(document.key))
      if (document.excluded) excludedIds.add(stableId)
    }
    if (document.excluded === "inactive")
      await sql(
        "UPDATE agentonic.documents SET active_version_id=NULL WHERE id=$1",
        [found.rows[0]!.document_id]
      )
    if (document.excluded === "revoked")
      await sql(
        "UPDATE agentonic.knowledge_sources SET configuration=configuration||'{\"revoked\":true}' WHERE id=(SELECT source_id FROM agentonic.documents WHERE id=$1)",
        [found.rows[0]!.document_id]
      )
  }
  for (const [caseIndex, test] of cases.entries()) {
    for (const mode of live ? ["hybrid", "reranked"] : ["diagnostic-hybrid"]) {
      // Fresh transaction time for job defaults/retention on slow provider runs.
      await db.exec("RESET ROLE; COMMIT; BEGIN")
      await actor()
      const queued = await rag("search", {
        query: test.query,
        collectionIds: [collection],
        generateAnswer: answers,
      })
      const job = (await claim()) as Lease
      const before = journal.reduce((n, r) => n + (r.actual ?? r.reserved), 0)
      const pacedBefore = pacingMs
      const started = performance.now()
      await worker(job, "search", {
        embedding: live
          ? queryVectors[caseIndex]
          : diagnosticVector(test.query),
        rerank: mode === "reranked",
      })
      let candidateRecall: number | null = null
      if (mode === "reranked") {
        const candidateContext = (await worker(job, "rerank-context")) as {
          passages: { id: string }[]
        }
        candidateRecall = retrievalMetrics(
          candidateContext.passages.map((p) => chunkKeys.get(p.id)!),
          [...new Set(test.relevant.map(canonical))],
          32
        ).recall
      }
      if (mode === "reranked")
        await rerankJob(test.query, job, execute, env.VOYAGE_API_KEY!, signal)
      if (answers)
        await generateAnswer(job, execute, env.OPENAI_API_KEY!, signal)
      const elapsed = performance.now() - started
      await actor()
      const result = await rag("result", { id: queued.id })
      if (result.status !== "succeeded")
        throw new Error("Benchmark job did not complete")
      const raw = await sql(
        "SELECT result FROM agentonic.background_jobs WHERE id=$1",
        [queued.id]
      )
      const answer = (
        raw.rows[0]!.result as {
          answer?: {
            text: string
            citations: string[]
            insufficientEvidence: boolean
          }
        }
      ).answer
      if (answer) {
        answerAudit.push({
          mode,
          key: test.key,
          text: answer.text,
          citations: answer.citations.map((id) => chunkKeys.get(id)!),
          abstained: answer.insufficientEvidence,
        })
        // Synthetic-only local evidence for manual audits; never included in Git reports.
        writeFileSync(
          `${directory}/synthetic-answers.json`,
          JSON.stringify(answerAudit, null, 2),
          { mode: 0o600 }
        )
      }
      const ranked = result.matches.map((p) => chunkKeys.get(p.id)!)
      const relevant = [...new Set(test.relevant.map(canonical))]
      const citations = answer?.citations ?? []
      rows.push({
        mode,
        key: test.key,
        split: test.split,
        category: test.category,
        ranked,
        ...retrievalMetrics(ranked, relevant),
        latencyMs: Math.round(elapsed - (pacingMs - pacedBefore)),
        pacingMs: pacingMs - pacedBefore,
        candidateRecall,
        baselineEvidenceRetained:
          mode === "reranked"
            ? rows
                .find((r) => r.key === test.key && r.mode === "hybrid")!
                .ranked.every((key) => ranked.includes(key))
            : null,
        microusd:
          journal.reduce((n, r) => n + (r.actual ?? r.reserved), 0) - before,
        duplicateCount: ranked.length - new Set(ranked).size,
        deniedPassages: result.matches.filter((p) => excludedIds.has(p.id))
          .length,
        abstained: answer?.insufficientEvidence ?? null,
        citationPrecision:
          answer && citations.length
            ? citations.filter((c) => relevant.includes(chunkKeys.get(c)!))
                .length / citations.length
            : null,
        expectedFactsPresent:
          answer && relevant.length
            ? !answer.insufficientEvidence &&
              test.facts.every((fact) =>
                new RegExp(fact, "iu").test(answer.text)
              )
            : null,
        unsupportedAnswer:
          answer && !relevant.length ? !answer.insufficientEvidence : null,
      })
      writeFileSync(
        `${directory}/progress.json`,
        JSON.stringify(
          { dataset: DATASET_VERSION, live, answers, rows },
          null,
          2
        ),
        { mode: 0o600 }
      )
      // Dispose of each local fixture job after measurement; do not weaken the
      // application's 10/minute user limit or retain synthetic answer text.
      await sql("DELETE FROM agentonic.background_jobs WHERE id=$1", [
        queued.id,
      ])
      // No query/answer text in logs; the corpus is versioned separately.
      console.log(`${mode}: ${test.key} completed`)
    }
  }
  const summaries = [...new Set(rows.map((r) => r.mode))].flatMap((mode) =>
    [...new Set(rows.map((r) => r.split))].map((split) => {
      const group = rows.filter((r) => r.mode === mode && r.split === split)
      return {
        mode,
        split,
        cases: group.length,
        baselineCoverageRetentionRate: mean(
          group.map((r) =>
            r.baselineEvidenceRetained === null
              ? null
              : Number(r.baselineEvidenceRetained)
          )
        ),
        candidateRecallAt32: mean(group.map((r) => r.candidateRecall)),
        hitAt8: mean(group.map((r) => r.hit)),
        recallAt8: mean(group.map((r) => r.recall)),
        mrrAt8: mean(group.map((r) => r.reciprocalRank)),
        ndcgAt8: mean(group.map((r) => r.ndcg)),
        latencyP50Ms: percentile(
          group.map((r) => r.latencyMs),
          0.5
        ),
        latencyP95Ms: percentile(
          group.map((r) => r.latencyMs),
          0.95
        ),
        totalMicrousd: group.reduce((n, r) => n + r.microusd, 0),
        duplicates: group.reduce((n, r) => n + r.duplicateCount, 0),
        deniedPassages: group.reduce((n, r) => n + r.deniedPassages, 0),
        citationPrecision: mean(group.map((r) => r.citationPrecision)),
        expectedFactMatchRate: mean(
          group.map((r) =>
            r.expectedFactsPresent === null
              ? null
              : Number(r.expectedFactsPresent)
          )
        ),
        noEvidenceAbstentionRate: mean(
          group
            .filter((r) => r.unsupportedAnswer !== null)
            .map((r) => Number(r.abstained))
        ),
        unsupportedAnswerRate: mean(
          group.map((r) =>
            r.unsupportedAnswer === null ? null : Number(r.unsupportedAnswer)
          )
        ),
      }
    })
  )
  const report = {
    dataset: DATASET_VERSION,
    corpusSha256: createHash("sha256")
      .update(JSON.stringify({ documents, cases }))
      .digest("hex"),
    createdAt: new Date().toISOString(),
    gitCommit: execFileSync("git", ["rev-parse", "HEAD"]).toString().trim(),
    workingTreeModified:
      execFileSync("git", ["status", "--porcelain"]).length > 0,
    live,
    answers,
    profile: RETRIEVAL_PROFILE,
    implementationHashes: Object.fromEntries(
      [
        "apps/worker/src/pipeline.ts",
        "apps/worker/src/reranking.ts",
        "apps/worker/src/answer.ts",
        "apps/worker/src/chunking.ts",
        "scripts/rag-benchmark/coverage-dataset.ts",
        "scripts/rag-benchmark/metrics.ts",
        "packages/database/prisma/migrations/202609180028_reranking/migration.sql",
      ].map((path) => [
        path,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ])
    ),
    embedding: live ? "voyage-4/1024" : "diagnostic-token-hash/1024",
    chunker: "sections-v1",
    reranker: live ? RERANK_MODEL : null,
    answerModel: answers ? "gpt-4.1-mini-2025-04-14" : null,
    limitations: [
      "Synthetic diagnostic corpus; not a customer-domain accuracy claim.",
      "Expected-fact regex and expected-source citations are proxies, not semantic entailment grading.",
      "Knowledge-answer path measured; frozen persona runtime and VM/network load not benchmarked.",
      "Single sample per question/mode; p95 is descriptive, not a production SLO.",
      "Modes share batched query embeddings; row costs exclude shared embedding setup. Latencies exclude deliberate provider pacing, which is reported per row.",
    ],
    summaries,
    gates: {
      accessIsolation: rows.every((r) => r.deniedPassages === 0),
      baselineEvidenceRetained: live
        ? rows
            .filter((r) => r.mode === "reranked")
            .every((r) => r.baselineEvidenceRetained)
        : null,
      recallNonRegression: live
        ? rows
            .filter((r) => r.mode === "reranked" && r.recall !== null)
            .every(
              (r) =>
                r.recall! >=
                rows.find((b) => b.key === r.key && b.mode === "hybrid")!
                  .recall!
            )
        : null,
      answerCompletenessNonRegression:
        live && answers
          ? rows
              .filter((r) => r.mode === "reranked")
              .every(
                (r) =>
                  rows.find((b) => b.key === r.key && b.mode === "hybrid")!
                    .expectedFactsPresent !== true ||
                  r.expectedFactsPresent === true
              )
          : null,
    },
    rows,
    totalMicrousd: journal.reduce((n, r) => n + (r.actual ?? r.reserved), 0),
  }
  writeFileSync(
    `${directory}/report.json`,
    JSON.stringify(report, null, 2) + "\n",
    { mode: 0o600 }
  )
  console.log(
    JSON.stringify(
      {
        report: `${directory}/report.json`,
        totalMicrousd: report.totalMicrousd,
        summaries,
      },
      null,
      2
    )
  )
  if (Object.values(report.gates).some((passed) => passed === false)) {
    console.error(
      "Benchmark quality gate failed; see report. No default activation."
    )
    process.exitCode = 1
  }
} catch (error) {
  const code =
    error instanceof Error &&
    [
      "provider_unavailable",
      "budget_exhausted",
      "lease_lost",
      "configuration_required",
    ].includes(error.message)
      ? error.message
      : "benchmark_failed"
  const cause =
    error instanceof Error
      ? (error.cause as { status?: number } | undefined)
      : undefined
  console.error(
    JSON.stringify({
      code,
      ...(Number.isInteger(cause?.status) ? { httpStatus: cause!.status } : {}),
    })
  )
  // Driver/provider errors may contain credentials or text. Preserve only content-free accounting.
  persist()
  console.error(
    `Benchmark failed; usage reservations retained in ${directory}/usage.json`
  )
  process.exitCode = 1
} finally {
  await db.close()
}
