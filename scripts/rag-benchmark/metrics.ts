export function retrievalMetrics(ranked: string[], relevant: string[], k = 8) {
  const truth = new Set(relevant)
  const top = ranked.slice(0, k)
  if (!truth.size)
    return { hit: null, recall: null, reciprocalRank: null, ndcg: null }
  const hits = new Set(top.filter((id) => truth.has(id))).size
  const first = top.findIndex((id) => truth.has(id))
  const credited = new Set<string>()
  const dcg = top.reduce((n, id, i) => {
    if (!truth.has(id) || credited.has(id)) return n
    credited.add(id)
    return n + 1 / Math.log2(i + 2)
  }, 0)
  const ideal = Array.from(
    { length: Math.min(k, truth.size) },
    (_, i) => 1 / Math.log2(i + 2)
  ).reduce((a, b) => a + b, 0)
  return {
    hit: hits > 0 ? 1 : 0,
    recall: hits / truth.size,
    reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
    ndcg: dcg / ideal,
  }
}
export function mean(values: (number | null)[]) {
  const valid = values.filter((n): n is number => n !== null)
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null
}
export function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length
    ? sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!
    : null
}
