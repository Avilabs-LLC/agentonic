// Tools for platform evaluation cases (architecture §51). An evaluated agent
// that has Gmail, Drive or web tools runs them against a case's synthetic fixtures:
// its model calls are real, but no mailbox, page or provider is reached, writes
// are only proposed, and every call is recorded for the grader. Results have the
// same shape as the real tools' (gmail.ts, drive.ts, web.ts), so the frozen runtime sees
// what it would see in a chat.
import { randomUUID } from "node:crypto"
import { gmailReads, parseGmailCall } from "@agentonic/contracts/gmail"
import { webArguments } from "@agentonic/contracts/web"
import {
  GOOGLE_DOC,
  driveTypes,
  parseDriveCall,
} from "@agentonic/contracts/drive"
import type {
  EvaluationFixtures,
  FixtureCall,
} from "@agentonic/contracts/evaluation-fixtures"
import type { Providers } from "./providers"
import { searchExcerpt } from "./gmail"

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^\p{L}\p{N}@.]+/u)
    .filter((w) => w.length > 2)
/** Records matching any word of the query, or all of them for an empty query. */
function matching<T>(records: T[], query: string, text: (r: T) => string) {
  const terms = words(query)
  if (!terms.length) return records
  return records.filter((r) => {
    const haystack = text(r).toLowerCase()
    return terms.some((t) => haystack.includes(t))
  })
}
const headers = (m: NonNullable<EvaluationFixtures["mailbox"]>[number]) => [
  { name: "From", value: m.from },
  { name: "To", value: m.to },
  { name: "Subject", value: m.subject },
  { name: "Date", value: m.date },
]

export function fixtureProviders(
  base: Providers,
  fixtures: EvaluationFixtures,
  calls: FixtureCall[]
): Providers {
  const mailbox = fixtures.mailbox ?? [],
    pages = fixtures.web ?? [],
    files = fixtures.drive ?? []
  return {
    ...base,
    web: pages.length > 0,
    gmail: mailbox.length > 0,
    // Never the live Drive: without Drive fixtures no Drive tool is offered.
    drive: files.length > 0,
    async driveTool(operation, args, grant) {
      const call = parseDriveCall(operation, args)
      if (!grant.operations.includes(call.operation))
        throw new Error("runtime_mismatch")
      calls.push({ tool: call.operation, arguments: call.arguments })
      const a = call.arguments as Record<string, string>
      const type = (mimeType: string) => driveTypes[mimeType] ?? "Archivo"
      if (call.operation === "drive.files.list") {
        const filter = a.name!.trim().toLowerCase()
        return {
          files: files
            .filter((f) => !filter || f.name.toLowerCase().includes(filter))
            .map((f) => ({ id: f.id, name: f.name, type: type(f.mimeType) })),
          untrusted: true,
        }
      }
      if (call.operation === "drive.docs.create")
        return { pendingApproval: true, id: randomUUID() }
      const file = files.find((f) => f.id === a.id)
      if (!file) return { error: "not_in_agent_files", untrusted: true }
      if (call.operation === "drive.files.read")
        return {
          id: file.id,
          name: file.name,
          type: type(file.mimeType),
          text: file.text,
          truncated: false,
          untrusted: true,
        }
      // Updates are proposed for the owner's confirmation and never executed.
      return file.mimeType === GOOGLE_DOC
        ? { pendingApproval: true, id: randomUUID() }
        : { error: "not_a_google_doc", untrusted: true }
    },
    async webTool(operation, args) {
      const parsed = webArguments[operation].safeParse(args)
      if (!parsed.success) throw new Error("runtime_mismatch")
      calls.push({ tool: operation, arguments: parsed.data })
      if (operation === "web.search") {
        const { query } = parsed.data as { query: string }
        return {
          results: matching(pages, query, (p) => `${p.title} ${p.text}`).map(
            (p) => ({ title: p.title, url: p.url })
          ),
          ok: true,
          untrusted: true,
        }
      }
      const { url } = parsed.data as { url: string }
      const page = pages.find((p) => p.url === url)
      return page
        ? { url: page.url, text: page.text, ok: true, untrusted: true }
        : {
            ok: false,
            error: "not_found",
            stop: false,
            untrusted: true,
            guidance:
              "This source was not verified. Do not infer its contents or retry this request. Try a different source within the remaining allowance, or explain the limitation.",
          }
    },
    async gmailTool(operation, args, grant, _job, _execute, options) {
      const call = parseGmailCall(operation, args)
      if (!grant.operations.includes(call.operation))
        throw new Error("runtime_mismatch")
      calls.push({ tool: call.operation, arguments: call.arguments })
      const a = call.arguments as Record<string, unknown>
      if (call.operation === "gmail.search") {
        const found = matching(
          mailbox,
          String(a.query),
          (m) => `${m.from} ${m.to} ${m.subject} ${m.text}`
        ).slice(0, Number(a.limit))
        // As in a chat, a search expands its results only with the read grant.
        return {
          messages: grant.operations.includes("gmail.read")
            ? found.map((m) => ({
                id: m.id,
                ...(options?.batch ? { threadId: m.id } : {}),
                headers: headers(m),
                excerpt: m.text.slice(
                  0,
                  searchExcerpt(options?.batch === true)
                ),
                untrusted: true,
              }))
            : found.map((m) => ({ id: m.id, threadId: m.id })),
        }
      }
      if (call.operation === "gmail.read") {
        const m = mailbox.find((x) => x.id === a.id)
        return m
          ? {
              id: m.id,
              threadId: m.id,
              headers: headers(m),
              text: m.text,
              untrusted: true,
            }
          : { error: "not_found", untrusted: true }
      }
      if (call.operation === "gmail.drafts.list") return { drafts: [] }
      if (gmailReads.some((read) => read === call.operation))
        return { error: "not_found", untrusted: true }
      // Writes are proposed for the owner's confirmation and never executed.
      return { pendingApproval: true, id: randomUUID() }
    },
  }
}
