// Only allowlisted classifications reach logs. Never log a raw provider/SQL
// message: it may contain mailbox content, tokens or private query arguments.
const known = new Set([
  "provider_unavailable",
  "budget_exhausted",
  "invalid_document",
  "ocr_required",
  "too_much_text",
  "storage_unavailable",
  "configuration_required",
  "lease_lost",
  // Google refused the account's authorization (§84).
  "google_reconnect",
])
export class PreviewFailure extends Error {
  constructor(
    public diagnostic:
      | "answer_json_invalid"
      | "answer_citations_invalid"
      | "answer_schema_invalid"
      | "response_incomplete"
  ) {
    super("provider_unavailable")
  }
}
/**
 * A turn's failure with its cause (architecture §67): `message` is the code
 * recorded and shown, `diagnostic` a content-free name for the log, such as
 * `answer_refused` or `runtime_runtime_failed`.
 */
export class TurnFailure extends Error {
  constructor(
    code: string,
    public diagnostic: string
  ) {
    super(code)
  }
}
export function workerFailure(error: unknown) {
  if (error instanceof PreviewFailure)
    return { code: error.message, diagnostic: error.diagnostic }
  if (error instanceof TurnFailure)
    return {
      code:
        error.message === "runtime_mismatch" || !known.has(error.message)
          ? "provider_unavailable"
          : error.message,
      diagnostic: error.diagnostic,
    }
  if (error instanceof Error && known.has(error.message))
    return { code: error.message, diagnostic: error.message }
  if (error instanceof Error && error.message === "runtime_mismatch")
    return { code: "provider_unavailable", diagnostic: "runtime_mismatch" }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "42501"
  )
    return { code: "lease_lost", diagnostic: "authorization_denied" }
  // Preserve the non-retrying fallback for unknown ingestion failures.
  return { code: "lease_lost", diagnostic: "unclassified_failure" }
}
