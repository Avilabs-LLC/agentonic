// Re-verification and alert policy for staging registrations. Pure functions only:
// the Mac job (run.mjs) gathers facts and changes state; the GitHub Action (alert.mjs)
// manages the alert issue. Keep this file to erasable TypeScript without imports so
// Node can load it with type stripping in the Action.

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
/** Database functions accept registrations verified within the last seven days. */
export const VALIDITY_MS = 7 * DAY
/** The scheduled job renews registrations that expire within this window. */
export const RENEW_WITHIN_MS = 2 * DAY
/** Watched registrations closer than this to expiry raise an alert. */
export const ALERT_WITHIN_MS = DAY
/** The Action alerts when the Mac job has not reported for this long. */
export const STALE_REPORT_MS = 36 * HOUR
/** Approval evidence stays usable for this long after an evaluation passes. */
export const EVIDENCE_WINDOW_MS = DAY

export const NODE = "/opt/agentonic/node/v22.23.2/bin/node"
export const RUNTIME_ROOT = "/opt/agentonic/runtime/artifacts"
export const EVAL_USER = "agentonic-eval"

export type Target =
  "azure-host" | "azure-evaluator" | "local-host" | "local-evaluator"
export const TARGETS: readonly Target[] = [
  "azure-host",
  "azure-evaluator",
  "local-host",
  "local-evaluator",
]
/** Only the Azure registrations serve other people; local ones are developer conveniences. */
export const isWatched = (target: string) => target.startsWith("azure-")
export const isEvaluator = (target: Target) => target.endsWith("-evaluator")

export type Registration = {
  id: string
  verifiedAt: string
  revokedAt: string | null
  /** Runtime artifacts this registration serves side by side. */
  runtimes: string[]
  /** Broker hash for hosts, worker hash for evaluators. */
  codeSha256: string
  verification?: Record<string, unknown>
}

export const validUntil = (verifiedAt: string) =>
  new Date(Date.parse(verifiedAt) + VALIDITY_MS)

export type Plan =
  | { renew: true; reason: "due" | "expired" | "requested" }
  | {
      renew: false
      reason:
        "not_due" | "missing" | "revoked" | "not_selected" | "expired_local"
    }

/**
 * Decide whether to renew. Unattended runs keep valid registrations valid and recover
 * expired Azure ones; an expired local registration is only renewed when named
 * explicitly, so lapsed developer setups are not revived silently.
 */
export function planRenewal(input: {
  target: Target
  registration: Registration | null
  now: Date
  selected?: readonly Target[]
  anyTime?: boolean
}): Plan {
  const { target, registration, now, selected, anyTime } = input
  if (selected && !selected.includes(target))
    return { renew: false, reason: "not_selected" }
  if (!registration) return { renew: false, reason: "missing" }
  if (registration.revokedAt) return { renew: false, reason: "revoked" }
  const left = validUntil(registration.verifiedAt).getTime() - now.getTime()
  if (left <= 0) {
    if (!isWatched(target) && !selected)
      return { renew: false, reason: "expired_local" }
    return { renew: true, reason: "expired" }
  }
  if (left <= RENEW_WITHIN_MS) return { renew: true, reason: "due" }
  return anyTime
    ? { renew: true, reason: "requested" }
    : { renew: false, reason: "not_due" }
}

// ---------------------------------------------------------------------------
// Facts and checks
//
// A fact key names one observation; the value is what the machine reported. The
// same keys generate the remote shell script, so checks and gathering cannot drift.

export type Facts = Record<string, string | undefined>
export type Check = {
  name: string
  key: string
  expect: string | ((value: string | undefined, facts: Facts) => boolean)
}

const HEX = /^[a-f0-9]{64}$/
const SAFE_PATH = /^\/[A-Za-z0-9._/@-]+$/
export function assertHash(value: string) {
  if (!HEX.test(value)) throw new Error("Invalid hash")
  return value
}
export function assertPath(value: string) {
  if (!SAFE_PATH.test(value) || value.split("/").includes(".."))
    throw new Error("Unsafe path")
  return value
}
const unquote = (value: string | undefined) => {
  if (value === undefined) return undefined
  try {
    return value.startsWith('"') ? (JSON.parse(value) as string) : value
  } catch {
    return value
  }
}
const parseUnit = (value: string | undefined) =>
  Object.fromEntries(
    (value ?? "")
      .split("|")
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf("=")
        return [line.slice(0, at), line.slice(at + 1)]
      })
  ) as Record<string, string>
const rootOwned = (mode: string) => (value: string | undefined) =>
  value === `root:root:${mode}`
const rootNotWritable = (value: string | undefined) => {
  const [user, group, mode] = (value ?? "").split(":")
  return (
    user === "root" &&
    group === "root" &&
    /^[0-7]{3,4}$/.test(mode ?? "") &&
    (parseInt(mode!, 8) & 0o022) === 0
  )
}

/** One installed runtime artifact: its manifest hash and every file hash in it. */
export type Runtime = { sha256: string; files: Record<string, string> }
const runtimeName = (sha256: string) => `runtime ${sha256.slice(0, 12)}`
function artifactChecks(runtimes: Runtime[]) {
  return runtimes.flatMap(({ sha256, files }) => {
    const dir = `${RUNTIME_ROOT}/${assertHash(sha256)}`
    const name = runtimeName(sha256)
    return [
      {
        name: `${name} manifest hash`,
        key: `sha:${dir}/manifest.json`,
        expect: sha256,
      },
      ...Object.entries(files).map(([path, sha]) => ({
        name: `${name} file ${path}`,
        key: `sha:${assertPath(`${dir}/${path}`)}`,
        expect: assertHash(sha),
      })),
      {
        name: `${name} files root-owned and read-only`,
        key: `loose:${dir}`,
        expect: "0",
      },
    ] satisfies Check[]
  })
}
const baseChecks: Check[] = [
  { name: "host identity", key: "hostname", expect: "vm-agents-01" },
  { name: "pinned Node version", key: `version:${NODE}`, expect: "v22.23.2" },
  {
    name: "Node binary protected",
    key: `stat:${NODE}`,
    expect: rootNotWritable,
  },
  { name: "no listening Node process", key: "listeners", expect: "0" },
]
function unitChecks(unit: string, path: string, sha256: string): Check[] {
  return [
    { name: `${unit} unit file`, key: `sha:${path}`, expect: sha256 },
    {
      name: `${unit} unit file protected`,
      key: `stat:${path}`,
      expect: rootOwned("644"),
    },
    {
      name: `${unit} unit loaded as installed`,
      key: `unit:${unit}`,
      expect: (value) => {
        const unitState = parseUnit(value)
        return (
          unitState.UnitFileState === "enabled" &&
          unitState.NeedDaemonReload === "no" &&
          unitState.DropInPaths === ""
        )
      },
    },
  ]
}
/** A running process must execute the verified program; a stopped one is reported elsewhere. */
const runsCommand = (command: string) => (value: string | undefined) =>
  value === "none" || value === command

export function azureHostChecks(input: {
  brokerSha256: string
  runtimes: Runtime[]
  runtimeUnitSha256: string
  controllerUnitSha256: string
}): Check[] {
  const broker = assertHash(input.brokerSha256)
  const release = `/opt/agentonic/staging/releases/${broker}`
  const config = "/etc/agentonic/staging"
  return [
    ...baseChecks,
    {
      name: "broker program hash",
      key: `sha:${release}/broker.mjs`,
      expect: broker,
    },
    {
      name: "broker program read-only",
      key: `stat:${release}/broker.mjs`,
      expect: rootOwned("444"),
    },
    { name: "broker release protected", key: `loose:${release}`, expect: "0" },
    ...artifactChecks(input.runtimes),
    ...unitChecks(
      "agentonic-deployer-staging.service",
      "/etc/systemd/system/agentonic-deployer-staging.service",
      assertHash(input.controllerUnitSha256)
    ),
    {
      name: "agent service template",
      key: "sha:/etc/systemd/system/agentonic-staging@.service",
      expect: assertHash(input.runtimeUnitSha256),
    },
    {
      name: "agent service template protected",
      key: "stat:/etc/systemd/system/agentonic-staging@.service",
      expect: rootOwned("644"),
    },
    {
      name: "staging configuration private",
      key: `stat:${config}`,
      expect: rootOwned("700"),
    },
    {
      name: "agent configuration private",
      key: `stat:${config}/agents`,
      expect: rootOwned("700"),
    },
    ...(["broker.env", "manager.env"] as const).flatMap((file): Check[] => [
      {
        name: `${file} private`,
        key: `stat:${config}/${file}`,
        expect: rootOwned("600"),
      },
      {
        name: `${file} pins broker`,
        key: `env:${config}/${file}#AGENTONIC_BROKER_SHA256`,
        expect: (value) => unquote(value) === broker,
      },
      {
        name: `${file} pins runtime root`,
        key: `env:${config}/${file}#AGENTONIC_RUNTIME_ROOT`,
        expect: (value) => unquote(value) === RUNTIME_ROOT,
      },
    ]),
    {
      name: "controller runs verified program",
      key: "cmdline:agentonic-deployer-staging.service",
      expect: runsCommand(`${NODE} ${release}/broker.mjs --manager`),
    },
    {
      name: "agent services run verified program",
      key: "instances",
      expect: (_value, facts) =>
        Object.entries(facts)
          .filter(([key]) => key.startsWith("instance:"))
          .every(([, command]) => command === `${NODE} ${release}/broker.mjs`),
    },
  ]
}

export function azureEvaluatorChecks(input: {
  workerSha256: string
  runtimes: Runtime[]
  unitSha256: string
}): Check[] {
  const worker = assertHash(input.workerSha256)
  const release = `/opt/agentonic/evaluation/releases/${worker}`
  const config = "/etc/agentonic/evaluation-staging"
  return [
    ...baseChecks,
    {
      name: "evaluator program hash",
      key: `sha:${release}/worker.mjs`,
      expect: worker,
    },
    {
      name: "evaluator program read-only",
      key: `stat:${release}/worker.mjs`,
      expect: rootOwned("444"),
    },
    {
      name: "evaluator release protected",
      key: `loose:${release}`,
      expect: "0",
    },
    ...artifactChecks(input.runtimes),
    ...unitChecks(
      "agentonic-evaluator-staging.service",
      "/etc/systemd/system/agentonic-evaluator-staging.service",
      assertHash(input.unitSha256)
    ),
    {
      name: "evaluator configuration private",
      key: `stat:${config}`,
      expect: rootOwned("700"),
    },
    {
      name: "worker.env private",
      key: `stat:${config}/worker.env`,
      expect: rootOwned("600"),
    },
    {
      name: "worker.env pins evaluator",
      key: `env:${config}/worker.env#AGENTONIC_EVALUATION_WORKER_SHA256`,
      expect: (value) => unquote(value) === worker,
    },
    {
      name: "worker.env pins runtime root",
      key: `env:${config}/worker.env#AGENTONIC_RUNTIME_ROOT`,
      expect: (value) => unquote(value) === RUNTIME_ROOT,
    },
    {
      name: "dedicated evaluator account",
      key: `shell:${EVAL_USER}`,
      expect: "/usr/sbin/nologin",
    },
    {
      name: "evaluator cannot modify its program",
      key: `canwrite:${EVAL_USER}:${release}/worker.mjs`,
      expect: "no",
    },
    {
      name: "evaluator cannot read its secrets file",
      key: `canread:${EVAL_USER}:${config}/worker.env`,
      expect: "no",
    },
    {
      name: "evaluator runs verified program",
      key: "cmdline:agentonic-evaluator-staging.service",
      expect: runsCommand(`${NODE} ${release}/worker.mjs`),
    },
  ]
}

/** Local registrations: the bytes and private files on this Mac. Modes only; no root. */
export function localHostChecks(input: {
  root: string
  brokerSha256: string
  runtimes: Runtime[]
}): Check[] {
  const broker = assertHash(input.brokerSha256)
  const release = `${input.root}/.local/staging/releases/${broker}`
  const config = `${input.root}/.local/staging/config`
  return [
    {
      name: "broker program hash",
      key: `sha:${release}/broker.mjs`,
      expect: broker,
    },
    ...localArtifactChecks(input),
    ...(["broker.env", "manager.env"] as const).flatMap((file): Check[] => [
      { name: `${file} private`, key: `mode:${config}/${file}`, expect: "600" },
      {
        name: `${file} pins broker`,
        key: `env:${config}/${file}#AGENTONIC_BROKER_SHA256`,
        expect: (value) => unquote(value) === broker,
      },
    ]),
  ]
}
export function localEvaluatorChecks(input: {
  root: string
  workerSha256: string
  runtimes: Runtime[]
}): Check[] {
  const worker = assertHash(input.workerSha256)
  const profile = `${input.root}/apps/worker/.env.evaluation.local`
  return [
    {
      name: "evaluator program hash",
      key: `sha:${input.root}/.local/evaluation/releases/${worker}/worker.mjs`,
      expect: worker,
    },
    ...localArtifactChecks(input),
    {
      name: "evaluator profile private",
      key: `mode:${profile}`,
      expect: "600",
    },
    {
      name: "evaluator profile pins evaluator",
      key: `env:${profile}#AGENTONIC_EVALUATION_WORKER_SHA256`,
      expect: (value) => unquote(value) === worker,
    },
  ]
}
function localArtifactChecks(input: {
  root: string
  runtimes: Runtime[]
}): Check[] {
  return input.runtimes.flatMap(({ sha256, files }) => {
    const dir = `${input.root}/.local/runtime/${assertHash(sha256)}`
    const name = runtimeName(sha256)
    return [
      {
        name: `${name} manifest hash`,
        key: `sha:${dir}/manifest.json`,
        expect: sha256,
      },
      ...Object.entries(files).map(([path, sha]) => ({
        name: `${name} file ${path}`,
        key: `sha:${assertPath(`${dir}/${path}`)}`,
        expect: assertHash(sha),
      })),
    ]
  })
}

/** Names of failed checks. Missing facts fail. */
export function failedChecks(checks: Check[], facts: Facts) {
  return checks
    .filter((check) => {
      const value = facts[check.key]
      return typeof check.expect === "string"
        ? value !== check.expect
        : !check.expect(value, facts)
    })
    .map((check) => check.name)
}

const quote = (path: string) => `'${assertPath(path)}'`
/** Shell lines that print `key<TAB>value` for each fact, run as root on the VM. */
export function gatherScript(checks: Check[]) {
  const lines = [
    "set -u",
    `f() { printf '%s\\t%s\\n' "$1" "$(printf '%s' "$2" | tr '\\n\\t' '  ')"; }`,
  ]
  for (const key of [...new Set(checks.map((check) => check.key))]) {
    const at = key.indexOf(":")
    const kind = at < 0 ? key : key.slice(0, at)
    const arg = at < 0 ? "" : key.slice(at + 1)
    const out = (command: string) => lines.push(`f '${key}' "$(${command})"`)
    if (kind === "hostname") out("hostname")
    else if (kind === "listeners")
      out(`ss -H -ltnup 2>/dev/null | grep -c '"node"'`)
    else if (kind === "version") out(`${quote(arg)} --version 2>/dev/null`)
    else if (kind === "sha")
      out(`sha256sum -- ${quote(arg)} 2>/dev/null | cut -d' ' -f1`)
    else if (kind === "stat")
      out(`stat -c '%U:%G:%a' -- ${quote(arg)} 2>/dev/null`)
    else if (kind === "loose")
      out(
        `test -d ${quote(arg)} && find ${quote(arg)} \\( ! -user root -o ! -group root -o -perm /022 \\) | wc -l || echo missing`
      )
    else if (kind === "env") {
      const [file, name] = arg.split("#")
      if (!/^[A-Z0-9_]+$/.test(name ?? "")) throw new Error("Unsafe key")
      out(`sed -n 's/^${name}=//p' ${quote(file!)} 2>/dev/null | head -1`)
    } else if (kind === "unit") {
      if (!/^[a-z@.-]+\.service$/.test(arg)) throw new Error("Unsafe unit")
      out(
        `systemctl show -p ActiveState,UnitFileState,NeedDaemonReload,DropInPaths ${arg} 2>/dev/null | tr '\\n' '|'`
      )
    } else if (kind === "cmdline") {
      if (!/^[a-z@.-]+\.service$/.test(arg)) throw new Error("Unsafe unit")
      out(
        `pid=$(systemctl show -p MainPID --value ${arg}); if [ "\${pid:-0}" -gt 0 ]; then tr '\\0' ' ' < /proc/$pid/cmdline; else echo none; fi`
      )
    } else if (kind === "instances") {
      lines.push(
        `for u in $(systemctl list-units --type=service --state=running --plain --no-legend 'agentonic-staging@*' | awk '{print $1}'); do pid=$(systemctl show -p MainPID --value "$u"); f "instance:$u" "$(tr '\\0' ' ' < /proc/$pid/cmdline)"; done`
      )
      out("echo listed")
    } else if (kind === "shell") {
      if (arg !== EVAL_USER) throw new Error("Unexpected account")
      out(`getent passwd ${arg} | cut -d: -f7`)
    } else if (kind === "canwrite" || kind === "canread") {
      const [user, path] = [
        arg.slice(0, arg.indexOf(":")),
        arg.slice(arg.indexOf(":") + 1),
      ]
      if (user !== EVAL_USER) throw new Error("Unexpected account")
      const flag = kind === "canwrite" ? "-w" : "-r"
      out(
        `runuser -u ${user} -- test ${flag} ${quote(path)} && echo yes || echo no`
      )
    } else throw new Error(`Unknown fact ${kind}`)
  }
  return lines.join("\n") + "\n"
}
export function parseFacts(output: string): Facts {
  const facts: Facts = {}
  for (const line of output.split("\n")) {
    const tab = line.indexOf("\t")
    if (tab > 0) facts[line.slice(0, tab)] = line.slice(tab + 1).trim()
  }
  return facts
}

// ---------------------------------------------------------------------------
// Report and alerts

export type Outcome =
  | "renewed"
  | "valid"
  | "deferred"
  | "failed"
  | "expired"
  | "missing"
  | "revoked"
  | "verified"
export type Entry = {
  name: Target
  validUntil: string | null
  outcome: Outcome
  /** Content-free explanation: check names, counts and states only. */
  detail?: string
}
export type Report = {
  version: 1
  generatedAt: string
  assignee?: string
  registrations: Entry[]
}

/** Problems that need a person, judged at `now`. Only Azure registrations alert. */
export function problems(report: Report | null, now: Date): string[] {
  if (!report) return ["The renewal job on the Mac has never reported."]
  const out: string[] = []
  const age = now.getTime() - Date.parse(report.generatedAt)
  if (!(age <= STALE_REPORT_MS))
    out.push(
      `The renewal job on the Mac has not reported since ${utc(report.generatedAt)}. Wake the Mac or run \`pnpm staging:reverify --renew --publish\`.`
    )
  for (const entry of report.registrations.filter((e) => isWatched(e.name))) {
    const detail = entry.detail ? ` (${entry.detail})` : ""
    if (entry.outcome === "failed")
      out.push(
        `${entry.name}: verification failed${detail}. It was not renewed.`
      )
    else if (entry.outcome === "missing" || entry.outcome === "revoked")
      out.push(
        `${entry.name}: no active registration (${entry.outcome}). Reinstall and register it.`
      )
    else if (!entry.validUntil || Date.parse(entry.validUntil) <= now.getTime())
      out.push(
        `${entry.name}: expired${entry.validUntil ? ` at ${utc(entry.validUntil)}` : ""}${detail}.`
      )
    else if (Date.parse(entry.validUntil) - now.getTime() <= ALERT_WITHIN_MS)
      out.push(`${entry.name}: expires at ${utc(entry.validUntil)}${detail}.`)
    else if (entry.detail && entry.outcome === "renewed")
      out.push(`${entry.name}: renewed, but ${entry.detail}.`)
  }
  return out
}

export const utc = (iso: string) =>
  new Date(iso).toISOString().slice(0, 16).replace("T", " ") + " UTC"

export const ISSUE_TITLE = "Staging registrations need attention"
export const ISSUE_MARKER = "<!-- staging-registrations -->"

export function issueBody(report: Report | null, found: string[], now: Date) {
  const rows = (report?.registrations ?? []).map(
    (entry) =>
      `| ${entry.name}${isWatched(entry.name) ? "" : " (local, not alerted)"} | ${entry.validUntil ? utc(entry.validUntil) : "—"} | ${entry.outcome}${entry.detail ? `: ${entry.detail}` : ""} |`
  )
  return [
    ISSUE_MARKER,
    "Staging on `vm-agents-01` stops working when its registrations expire. The renewal job on the Mac normally renews them automatically; something below needs a person.",
    "",
    "**Needs attention**",
    ...found.map((line) => `- ${line}`),
    "",
    ...(rows.length
      ? [
          `**Last report from the Mac** (${utc(report!.generatedAt)})`,
          "",
          "| Registration | Valid until | Last result |",
          "|---|---|---|",
          ...rows,
          "",
        ]
      : []),
    "**To fix**, on the Mac: `pnpm staging:reverify` shows the state; `pnpm staging:reverify --renew --publish` re-verifies and renews. A failed check means the installation no longer matches what was reviewed: investigate before reinstalling.",
    "",
    `_Checked ${utc(now.toISOString())}. This issue closes itself once everything is valid again._`,
  ].join("\n")
}
