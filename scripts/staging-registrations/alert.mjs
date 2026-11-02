// Runs in GitHub Actions. Turns the Mac's published registration report, and a
// check of the hosted apps over HTTPS, into one assigned issue: opened as the workflow bot so the assignee is notified, reminded
// daily while unresolved, closed once everything is valid. A missing or stale report
// is itself a problem, so this also fires when the Mac job stops running.
import {
  ISSUE_MARKER,
  ISSUE_TITLE,
  DAY,
  issueBody,
  problems,
  utc,
} from "./policy.ts"
import { hostedProblems, siteProblems } from "../hosted-check.mjs"
import { hostnames, siteHostname } from "../platform-units.mjs"

const token = process.env.GITHUB_TOKEN
const repo = process.env.GITHUB_REPOSITORY
const dryRun = process.env.DRY_RUN === "1"
if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo ?? ""))
  throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required")

let report = null
try {
  const parsed = JSON.parse(process.env.STAGING_REGISTRATIONS || "null")
  if (parsed?.version === 1 && Array.isArray(parsed.registrations))
    report = parsed
} catch {
  /* An unreadable report is treated as missing. */
}

async function api(method, path, body) {
  if (dryRun && method !== "GET") {
    console.log(
      `[dry run] ${method} ${path}`,
      body ? JSON.stringify(body).slice(0, 300) : ""
    )
    return {}
  }
  const response = await globalThis.fetch(
    `https://api.github.com/repos/${repo}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    }
  )
  if (!response.ok)
    throw new Error(`GitHub ${method} ${path} failed with ${response.status}`)
  return response.status === 204 ? null : response.json()
}

const now = new Date()
// The hosted apps are checked from here, so they are watched even while the Mac is off.
const found = [
  ...problems(report, now),
  ...[
    ...(await hostedProblems(hostnames)),
    ...(await siteProblems(siteHostname)),
  ].map((problem) => `Hosted apps: ${problem}.`),
]
const fingerprint = found.join("\n")
const issues = await api("GET", "/issues?state=open&per_page=100")
const open = issues.find(
  (issue) =>
    !issue.pull_request &&
    issue.title === ISSUE_TITLE &&
    issue.body?.startsWith(ISSUE_MARKER)
)
const stateOf = (body) => {
  try {
    return JSON.parse(/<!-- state:(.*) -->/.exec(body ?? "")?.[1] ?? "{}")
  } catch {
    return {}
  }
}
const withState = (body, state) =>
  `${body}\n<!-- state:${JSON.stringify(state)} -->`

if (found.length && !open) {
  const created = await api("POST", "/issues", {
    title: ISSUE_TITLE,
    body: withState(issueBody(report, found, now), {
      fingerprint,
      notifiedAt: now.toISOString(),
    }),
    assignees: report?.assignee ? [report.assignee] : [],
  })
  console.log(
    `Opened issue #${created.number ?? "?"} with ${found.length} problem(s).`
  )
} else if (found.length) {
  const state = stateOf(open.body)
  const changed = state.fingerprint !== fingerprint
  const remind = !(Date.parse(state.notifiedAt) > now.getTime() - DAY)
  const notifiedAt = changed || remind ? now.toISOString() : state.notifiedAt
  await api("PATCH", `/issues/${open.number}`, {
    body: withState(issueBody(report, found, now), { fingerprint, notifiedAt }),
  })
  if (changed || remind)
    await api("POST", `/issues/${open.number}/comments`, {
      body: `${changed ? "Updated" : "Still unresolved"}:\n${found.map((line) => `- ${line}`).join("\n")}`,
    })
  console.log(
    `Issue #${open.number} updated (${changed ? "changed" : remind ? "reminder" : "unchanged"}).`
  )
} else if (open) {
  const next = (report?.registrations ?? [])
    .filter((entry) => entry.name.startsWith("azure-") && entry.validUntil)
    .map((entry) => entry.validUntil)
    .sort()[0]
  await api("POST", `/issues/${open.number}/comments`, {
    body: `Resolved: all Azure staging registrations are valid${next ? `; the next expiry is ${utc(next)}` : ""}, and the hosted apps answer.`,
  })
  await api("PATCH", `/issues/${open.number}`, {
    state: "closed",
    state_reason: "completed",
  })
  console.log(`Issue #${open.number} closed.`)
} else
  console.log("All Azure staging registrations are valid; no issue needed.")
