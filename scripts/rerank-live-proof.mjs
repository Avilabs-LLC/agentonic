import assert from "node:assert/strict"

// Multiple distinct chunks exercise the provider call; a one-passage fixture skips it.
// This is infrastructure smoke evidence, not a retrieval quality benchmark.
export const rerankSmokeDocument =
  "# Synthetic device policy\n\n## Warranty\n\n" +
  "The synthetic device warranty lasts three years. This is the complete published warranty-duration statement.\n\n".repeat(
    16
  ) +
  "## Delivery\n\n" +
  "Standard delivery takes seven business days. This is the complete published delivery-time statement.\n\n".repeat(
    16
  )

export async function verifyRerankUsage(db, jobId) {
  const operations = (
    await db.query(
      "SELECT status,actual_microusd,input_tokens FROM agentonic.retrieval_provider_operations WHERE job_id=$1 AND provider='voyage' AND model='rerank-2.5-lite'",
      [jobId]
    )
  ).rows
  assert.ok(operations.length > 0, "Installed worker must call the reranker")
  assert.ok(
    operations.every(
      (op) =>
        op.status === "settled" &&
        Number(op.actual_microusd) > 0 &&
        Number(op.input_tokens) > 0
    ),
    "Every rerank operation must have settled usage"
  )
  return {
    model: "rerank-2.5-lite",
    operations: operations.length,
    committedMicrousd: operations.reduce(
      (sum, op) => sum + Number(op.actual_microusd),
      0
    ),
  }
}
