// Re-verification and alert policy for staging registrations. Pure functions only:
// the Mac job (run.mjs) gathers facts and changes state; the GitHub Action (alert.mjs)
// manages the alert issue. Keep this file to erasable TypeScript without imports so
// Node can load it with type stripping in the Action.

export const HOUR = 3_600_000
export const DAY = 24 * HOUR
/** Database functions accept registrations verified within the last 30 days
 * (migration 52, owner decision 7 Oct 2026: the VM keeps working for weeks
 * with the Mac off). */
export const VALIDITY_MS = 30 * DAY
/** The scheduled job renews once a registration is a week old, so a Mac that
 * goes off leaves 23 to 30 days before anything stops. Renewal restarts the
 * evaluator, so it stays weekly rather than daily. */
export const RENEW_WITHIN_MS = VALIDITY_MS - 7 * DAY
/** Watched registrations closer than this to expiry raise an alert. */
export const ALERT_WITHIN_MS = DAY
/** The Action alerts when the Mac job has not reported for this long... */
export const STALE_REPORT_MS = 36 * HOUR
/** ...and a watched registration expires within this window. A quiet Mac is
 * expected for weeks at a time; it only needs a person before expiry. */
export const STALE_MATTERS_WITHIN_MS = 5 * DAY
/** Approval evidence stays usable for this long after an evaluation passes. */
export const EVIDENCE_WINDOW_MS = DAY

export const NODE = "/opt/agentonic/node/v22.23.2/bin/node"
export const RUNTIME_ROOT = "/opt/agentonic/runtime/artifacts"
export const EVAL_USER = "agentonic-eval"
/** The deployment controller's user and its polkit rule (scripts/staging-units.mjs). */
export const CONTROLLER_USER = "agentonic-controller"
export const CONTROLLER_RULES =
  "/etc/polkit-1/rules.d/50-agentonic-controller.rules"

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
  /** Evaluators only: normal succession ended this registration. */
  retiredAt?: string | null
  /** Runtime artifacts this registration serves side by side. */
  runtimes: string[]
  /** Current broker hash for hosts, worker hash for evaluators. */
  codeSha256: string
  /** Hosts only: every live broker release, the current one included. */
  brokers?: string[]
  verification?: Record<string, unknown>
}

export const validUntil = (verifiedAt: string) =>
  new Date(Date.parse(verifiedAt) + VALIDITY_MS)

export type Plan =
  | { renew: true; reason: "due" | "expired" | "requested" }
  | {
      renew: false
      reason:
        | "not_due"
        | "missing"
        | "revoked"
        | "retired"
        | "not_selected"
        | "expired_local"
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
  if (registration.retiredAt) return { renew: false, reason: "retired" }
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

/** One broker release installed on the host. */
export type Broker = { sha256: string; templateSha256: string }
const brokerName = (sha256: string) => `broker ${sha256.slice(0, 12)}`
const brokerRelease = (sha256: string) =>
  `/opt/agentonic/staging/releases/${assertHash(sha256)}`
const AGENT_INSTANCE =
  /^instance:agentonic-staging-([a-f0-9]{64})@[0-9a-f-]{36}\.service$/

const GATEWAY = "agentonic-gateway-staging"
const GATEWAY_SOCKET = "/run/agentonic-gateway/gateway.sock"
export function azureHostChecks(input: {
  /** The current broker: it runs the controller, the gateway and every new copy. */
  brokerSha256: string
  /** Every live broker release, current included; older ones still run copies. */
  brokers: Broker[]
  runtimes: Runtime[]
  controllerUnitSha256: string
  gatewayUnitSha256: string
  gatewaySocketSha256: string
  /**
   * The polkit rule's hash when the current broker's controller runs as its own
   * user; null while it runs as root (a broker whose copies need unit drop-ins).
   */
  controllerRulesSha256: string | null
}): Check[] {
  const current = assertHash(input.brokerSha256)
  const unprivileged = input.controllerRulesSha256 !== null
  if (!input.brokers.some((broker) => broker.sha256 === current))
    throw new Error("Current broker not listed")
  const live = new Set(input.brokers.map((broker) => assertHash(broker.sha256)))
  const config = "/etc/agentonic/staging"
  return [
    ...baseChecks,
    ...input.brokers.flatMap(({ sha256, templateSha256 }): Check[] => {
      const release = brokerRelease(sha256)
      const name = brokerName(sha256)
      const template = `/etc/systemd/system/agentonic-staging-${sha256}@.service`
      return [
        {
          name: `${name} program hash`,
          key: `sha:${release}/broker.mjs`,
          expect: sha256,
        },
        {
          name: `${name} program read-only`,
          key: `stat:${release}/broker.mjs`,
          expect: rootOwned("444"),
        },
        {
          name: `${name} release protected`,
          key: `loose:${release}`,
          expect: "0",
        },
        {
          name: `${name} agent service template`,
          key: `sha:${template}`,
          expect: assertHash(templateSha256),
        },
        {
          name: `${name} agent service template protected`,
          key: `stat:${template}`,
          expect: rootOwned("644"),
        },
      ]
    }),
    ...artifactChecks(input.runtimes),
    ...unitChecks(
      "agentonic-deployer-staging.service",
      "/etc/systemd/system/agentonic-deployer-staging.service",
      assertHash(input.controllerUnitSha256)
    ),
    ...unitChecks(
      `${GATEWAY}.service`,
      `/etc/systemd/system/${GATEWAY}.service`,
      assertHash(input.gatewayUnitSha256)
    ),
    ...unitChecks(
      `${GATEWAY}.socket`,
      `/etc/systemd/system/${GATEWAY}.socket`,
      assertHash(input.gatewaySocketSha256)
    ),
    {
      name: "gateway socket open only to agent copies",
      key: `stat:${GATEWAY_SOCKET}`,
      expect: "root:agentonic-gateway:660",
    },
    {
      name: "gateway runs the current broker",
      key: `cmdline:${GATEWAY}.service`,
      expect: runsCommand(
        `${NODE} ${brokerRelease(current)}/broker.mjs --gateway`
      ),
    },
    {
      name: "gateway.env private",
      key: `stat:${config}/gateway.env`,
      expect: rootOwned("600"),
    },
    {
      name: "gateway.env pins the current broker",
      key: `env:${config}/gateway.env#AGENTONIC_BROKER_SHA256`,
      expect: (value) => unquote(value) === current,
    },
    // Agent copies start from broker.env. The database password and every provider
    // and Gmail key stay with the gateway; probes count names and never read values.
    {
      name: "agent copies get no password or key",
      key: `secrets:${config}/broker.env`,
      expect: "0",
    },
    {
      name: "current broker's copies hold no password or key",
      key: `secrets:${config}/agents/${current}`,
      expect: "0",
    },
    ...(["OPENAI_API_KEY", "VOYAGE_API_KEY"] as const).map((name): Check => ({
      name: `gateway holds ${name}`,
      key: `defines:${config}/gateway.env#${name}`,
      expect: "yes",
    })),
    {
      name: "no shared agent service template",
      key: "sha:/etc/systemd/system/agentonic-staging@.service",
      expect: "",
    },
    // An unprivileged controller passes through the configuration directory to its
    // own agent directory; it cannot list it or read the files kept there.
    {
      name: "staging configuration private",
      key: `stat:${config}`,
      expect: unprivileged ? `root:${CONTROLLER_USER}:710` : rootOwned("700"),
    },
    {
      name: "agent configuration private",
      key: `stat:${config}/agents`,
      expect: unprivileged
        ? `${CONTROLLER_USER}:${CONTROLLER_USER}:700`
        : rootOwned("700"),
    },
    ...(unprivileged
      ? [
          {
            name: "controller runs as its own user",
            key: "user:agentonic-deployer-staging.service",
            expect: CONTROLLER_USER,
          },
          {
            name: "controller may manage agent copies only",
            key: `sha:${CONTROLLER_RULES}`,
            expect: assertHash(input.controllerRulesSha256!),
          },
          {
            name: "controller's polkit rule protected",
            key: `stat:${CONTROLLER_RULES}`,
            expect: rootOwned("644"),
          },
          {
            name: "deployment files private to the controller",
            key: "stat:/opt/agentonic/instances",
            expect: `${CONTROLLER_USER}:${CONTROLLER_USER}:700`,
          },
          {
            name: "no agent unit drop-ins",
            key: "dropins",
            expect: "0",
          },
        ]
      : []),
    ...(["broker.env", "manager.env"] as const).flatMap((file): Check[] => [
      {
        name: `${file} private`,
        key: `stat:${config}/${file}`,
        expect: rootOwned("600"),
      },
      {
        name: `${file} pins the current broker`,
        key: `env:${config}/${file}#AGENTONIC_BROKER_SHA256`,
        expect: (value) => unquote(value) === current,
      },
      {
        name: `${file} pins runtime root`,
        key: `env:${config}/${file}#AGENTONIC_RUNTIME_ROOT`,
        expect: (value) => unquote(value) === RUNTIME_ROOT,
      },
    ]),
    {
      name: "controller runs the current broker",
      key: "cmdline:agentonic-deployer-staging.service",
      expect: runsCommand(
        `${NODE} ${brokerRelease(current)}/broker.mjs --manager`
      ),
    },
    {
      name: "agent services run registered brokers",
      key: "instances",
      expect: (_value, facts) =>
        Object.entries(facts)
          .filter(([key]) => key.startsWith("instance:"))
          .every(([key, command]) => {
            const broker = AGENT_INSTANCE.exec(key)?.[1]
            return (
              !!broker &&
              live.has(broker) &&
              command === `${NODE} ${brokerRelease(broker)}/broker.mjs`
            )
          }),
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
  brokers: string[]
  runtimes: Runtime[]
}): Check[] {
  const current = assertHash(input.brokerSha256)
  const config = `${input.root}/.local/staging/config`
  return [
    ...input.brokers.map((broker) => ({
      name: `${brokerName(broker)} program hash`,
      key: `sha:${input.root}/.local/staging/releases/${assertHash(broker)}/broker.mjs`,
      expect: broker,
    })),
    ...localArtifactChecks(input),
    ...(["broker.env", "manager.env"] as const).flatMap((file): Check[] => [
      { name: `${file} private`, key: `mode:${config}/${file}`, expect: "600" },
      {
        name: `${file} pins the current broker`,
        key: `env:${config}/${file}#AGENTONIC_BROKER_SHA256`,
        expect: (value) => unquote(value) === current,
      },
    ]),
    // Installations from before the gateway have no gateway.env. When present it holds
    // the runtime role's password, so it must be private and match the current broker.
    {
      name: "gateway.env private",
      key: `mode:${config}/gateway.env`,
      expect: (value) => value === "missing" || value === "600",
    },
    {
      name: "gateway.env pins the current broker",
      key: `env:${config}/gateway.env#AGENTONIC_BROKER_SHA256`,
      expect: (value, facts) =>
        facts[`mode:${config}/gateway.env`] === "missing" ||
        unquote(value) === current,
    },
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

// ---------------------------------------------------------------------------
// Service health
//
// Gathered on every run, independent of renewal: a service that is waiting,
// failed or restarting is reported even while its registration is valid.

export const PLATFORM_SERVICES: [string, string][] = [
  ["agentonic-admin-staging.service", "the Admin app"],
  ["agentonic-customer-staging.service", "the customer app"],
  ["agentonic-knowledge-staging.service", "the knowledge worker"],
  ["caddy.service", "the TLS proxy"],
]
const SERVICES: Record<"azure-host" | "azure-evaluator", [string, string][]> = {
  "azure-host": [
    ["agentonic-deployer-staging.service", "the deployment controller"],
    [`${GATEWAY}.service`, "the database gateway"],
    // The hosted platform shares the host's report (architecture §53); the
    // names match scripts/platform-units.mjs, which a test compares.
    ...PLATFORM_SERVICES,
  ],
  "azure-evaluator": [["agentonic-evaluator-staging.service", "the evaluator"]],
}
const RESTART_TIMER = "agentonic-restart-window.timer"
const RESTART_SERVICE = "agentonic-restart-window.service"
/** Facts to gather for one Azure target's health and the machine it runs on. */
export function healthProbes(target: "azure-host" | "azure-evaluator") {
  return [
    ...SERVICES[target].flatMap(([unit]) => [
      { key: `state:${unit}` },
      { key: `event:${unit}` },
    ]),
    ...(target === "azure-host"
      ? [
          { key: "failedagents" },
          // The machine's planned restart window is reported with the host.
          { key: `sha:/etc/systemd/system/${RESTART_TIMER}` },
          { key: `sha:/etc/systemd/system/${RESTART_SERVICE}` },
          { key: `state:${RESTART_TIMER}` },
          { key: `next:${RESTART_TIMER}` },
        ]
      : []),
    { key: "boot" },
    { key: "reboot" },
  ]
}
/** Hashes of the reviewed restart window units (from scripts/staging-units.mjs). */
export type RestartWindow = { timerSha256: string; serviceSha256: string }
const WAITING: Record<string, string> = {
  registration_refused:
    "the database refuses its registration (expired, replaced or revoked)",
  database_unreachable: "the database is unreachable",
  database_busy: "the database is busy",
  database_error: "database errors",
}
/** Content-free health problems for one Azure target. */
export function healthFindings(
  target: "azure-host" | "azure-evaluator",
  facts: Facts,
  restartWindow?: RestartWindow
): string[] {
  const out: string[] = []
  for (const [unit, label] of SERVICES[target]) {
    const raw = facts[`state:${unit}`]
    if (raw === undefined) {
      out.push(`could not read the state of ${label}`)
      continue
    }
    const state = parseUnit(raw)
    if (state.ActiveState !== "active")
      out.push(
        `${label} is not running (${state.ActiveState || "unknown"}, ${state.Result || "unknown"}, ${Number(state.NRestarts) || 0} restarts)`
      )
    let event: { event?: unknown; reason?: unknown; since?: unknown } = {}
    try {
      event = JSON.parse(facts[`event:${unit}`] || "{}")
    } catch {
      /* An unreadable line says nothing about the state. */
    }
    if (
      event.event === "service_waiting" &&
      typeof event.reason === "string" &&
      /^[a-z_]{3,40}$/.test(event.reason)
    ) {
      const since =
        typeof event.since === "string" &&
        !Number.isNaN(Date.parse(event.since))
          ? ` since ${utc(event.since)}`
          : ""
      out.push(
        `${label} is waiting${since}: ${WAITING[event.reason] ?? event.reason.replaceAll("_", " ")}`
      )
    }
  }
  const failed = Number(facts.failedagents)
  if (target === "azure-host" && failed > 0)
    out.push(
      `${failed} agent service${failed === 1 ? " has" : "s have"} failed`
    )
  if (target === "azure-host" && restartWindow) {
    if (
      facts[`sha:/etc/systemd/system/${RESTART_TIMER}`] !==
        restartWindow.timerSha256 ||
      facts[`sha:/etc/systemd/system/${RESTART_SERVICE}`] !==
        restartWindow.serviceSha256
    )
      out.push(
        "the planned restart window is not installed as reviewed (`pnpm staging:restart-window`)"
      )
    else if (
      parseUnit(facts[`state:${RESTART_TIMER}`]).ActiveState !== "active"
    )
      out.push("the planned restart window is not active")
  }
  return out
}
/** Notes about the machine for the issue body; they never raise an alert by themselves. */
export function machineNotes(facts: Facts, now: Date): string[] {
  const notes: string[] = []
  const boot = Number(facts.boot) * 1000
  if (boot > 0)
    notes.push(
      `vm-agents-01 has been up since ${utc(new Date(boot).toISOString())}${now.getTime() - boot < DAY ? " (restarted within the last day)" : ""}.`
    )
  const pending = Number(facts.reboot) * 1000
  const next = facts[`next:${RESTART_TIMER}`]
  const window =
    next && !Number.isNaN(Date.parse(next))
      ? ` The planned restart window applies them on ${utc(next)}.`
      : " No restart window is planned."
  if (pending > 0)
    notes.push(
      `Installed updates have been waiting for a restart since ${utc(new Date(pending).toISOString())}.${window}`
    )
  return notes
}

/** A runtime release as the catalog records it: version and the commit it was built from. */
export type RuntimeRelease = { sha256: string; version: string; commit: string }
/**
 * What each registration runs: its worker releases and the runtime releases it
 * serves, by version and source commit, so the report shows which build each
 * environment runs. A runtime missing from the catalog is shown by its hash.
 */
export function releaseNotes(
  registrations: Record<
    string,
    { codeSha256: string; brokers?: string[]; runtimes: string[] } | null
  >,
  releases: RuntimeRelease[]
): string[] {
  const named = (sha256: string) => {
    const release = releases.find((r) => r.sha256 === sha256)
    if (!release) return sha256.slice(0, 12)
    const commit = release.commit.slice(0, 7)
    return release.version.includes(commit)
      ? release.version
      : `${release.version} (${commit})`
  }
  return Object.entries(registrations).flatMap(([target, registration]) => {
    if (!registration) return []
    const workers = registration.brokers?.length
      ? registration.brokers
      : [registration.codeSha256]
    const runtimes = registration.runtimes.map(named).sort()
    return [
      `${target} runs worker ${workers.map((w) => w.slice(0, 8)).join(", ")}; runtimes ${runtimes.length ? runtimes.join(", ") : "none"}.`,
    ]
  })
}

// ---------------------------------------------------------------------------
// VM backups (Azure Backup, read through the Azure CLI on the Mac)

/** Backups run daily; one missed day raises an alert at the next run after this age. */
export const BACKUP_STALE_MS = 36 * HOUR
/** What Azure reports for the VM's backup item; null when it could not be read. */
export type VmBackup = {
  protectionState: string
  lastBackupStatus: string
  lastBackupTime: string | null
} | null
const backupTime = (backup: NonNullable<VmBackup>) => {
  // Azure reports 2001-01-01 until the first backup completes.
  const time = Date.parse(backup.lastBackupTime ?? "")
  return time > Date.parse("2020-01-01T00:00:00Z") ? time : null
}
/** Content-free problems with the VM's backups. */
export function backupFindings(backup: VmBackup, now: Date): string[] {
  if (!backup)
    return [
      "could not check the VM backups; sign in again with `az login` on the Mac",
    ]
  const out: string[] = []
  if (!["Protected", "IRPending"].includes(backup.protectionState))
    out.push(
      `VM backups are not active (${/^[A-Za-z]{1,40}$/.test(backup.protectionState) ? backup.protectionState : "unknown"})`
    )
  if (backup.lastBackupStatus === "Failed")
    out.push("the last VM backup failed")
  const last = backupTime(backup)
  if (last === null) out.push("no VM backup has completed yet")
  else if (now.getTime() - last > BACKUP_STALE_MS)
    out.push(`the last VM backup is from ${utc(new Date(last).toISOString())}`)
  return out
}
/** A note for the issue body with the time of the last backup. */
export function backupNote(backup: VmBackup): string | null {
  const last = backup && backupTime(backup)
  return last
    ? `Last VM backup: ${utc(new Date(last).toISOString())}${backup.lastBackupStatus === "Completed" ? "" : ` (${backup.lastBackupStatus || "status unknown"})`}.`
    : null
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
/** Configuration names that hold a password or key. Probes may count them, never print them. */
export const SECRET_NAMES = [
  "DATABASE_URL",
  "OPENAI_API_KEY",
  "VOYAGE_API_KEY",
  "BROWSERBASE_API_KEY",
  "GOOGLE_CLIENT_SECRET",
  "AGENTONIC_CONNECTION_KEY",
  "AGENTONIC_CONNECTION_STANDBY_KEYS",
  "SUPABASE_SECRET_KEY",
]
export function gatherScript(checks: readonly { key: string }[]) {
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
      if (SECRET_NAMES.includes(name!)) throw new Error("Secret value")
      out(`sed -n 's/^${name}=//p' ${quote(file!)} 2>/dev/null | head -1`)
    } else if (kind === "defines") {
      // Whether a file sets a non-empty value, never the value.
      const [file, name] = arg.split("#")
      if (!/^[A-Z0-9_]+$/.test(name ?? "")) throw new Error("Unsafe key")
      out(
        `grep -qsE '^${name}="?[^"]' -- ${quote(file!)} && echo yes || echo no`
      )
    } else if (kind === "secrets") {
      // How many configuration files under a path set any password or key. Copies'
      // release credentials (customer text) sit beside them and are not read.
      out(
        `grep -rlsE --include='*.env' '^(${SECRET_NAMES.join("|")})="?[^"]' -- ${quote(arg)} | wc -l`
      )
    } else if (kind === "user") {
      if (!/^[a-z@.-]+\.service$/.test(arg)) throw new Error("Unsafe unit")
      out(
        `pid=$(systemctl show -p MainPID --value ${arg}); if [ "\${pid:-0}" -gt 0 ]; then stat -c %U /proc/$pid; else echo none; fi`
      )
    } else if (kind === "dropins") {
      // Unit drop-ins for agent copies; only root could write them.
      out(
        `find /etc/systemd/system -maxdepth 1 -name 'agentonic-staging-*@*.service.d' | wc -l`
      )
    } else if (kind === "unit") {
      if (!/^[a-z@.-]+\.(service|socket)$/.test(arg))
        throw new Error("Unsafe unit")
      out(
        `systemctl show -p ActiveState,UnitFileState,NeedDaemonReload,DropInPaths ${arg} 2>/dev/null | tr '\\n' '|'`
      )
    } else if (kind === "cmdline") {
      if (!/^[a-z@.-]+\.service$/.test(arg)) throw new Error("Unsafe unit")
      out(
        `pid=$(systemctl show -p MainPID --value ${arg}); if [ "\${pid:-0}" -gt 0 ]; then tr '\\0' ' ' < /proc/$pid/cmdline; else echo none; fi`
      )
    } else if (kind === "instances") {
      // Every agent copy, under any broker release's template or the retired shared one.
      lines.push(
        `for u in $(systemctl list-units --type=service --state=running --plain --no-legend 'agentonic-staging*@*' | awk '{print $1}'); do pid=$(systemctl show -p MainPID --value "$u"); f "instance:$u" "$(tr '\\0' ' ' < /proc/$pid/cmdline)"; done`
      )
      out("echo listed")
    } else if (kind === "state") {
      if (!/^[a-z@.-]+\.(service|timer)$/.test(arg))
        throw new Error("Unsafe unit")
      out(
        `systemctl show -p ActiveState,Result,NRestarts ${arg} 2>/dev/null | tr '\\n' '|'`
      )
    } else if (kind === "next") {
      if (!/^[a-z@.-]+\.timer$/.test(arg)) throw new Error("Unsafe unit")
      // The timer's next elapse as an ISO time the Mac can parse.
      out(
        `t=$(systemctl show -p NextElapseUSecRealtime --value ${arg} 2>/dev/null); date -u -d "$t" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo none`
      )
    } else if (kind === "event") {
      if (!/^[a-z@.-]+\.service$/.test(arg)) throw new Error("Unsafe unit")
      out(
        `journalctl -u ${arg} -o cat --no-pager -n 400 2>/dev/null | grep -E '^\\{"event":"service_(started|waiting|recovered|stopped)"' | tail -1`
      )
    } else if (kind === "failedagents") {
      out(
        `systemctl list-units --type=service --state=failed --plain --no-legend 'agentonic-staging*@*' | wc -l`
      )
    } else if (kind === "boot") {
      out(`awk '/^btime/{print $2}' /proc/stat`)
    } else if (kind === "reboot") {
      out(
        "if [ -f /var/run/reboot-required ]; then stat -c %Y /var/run/reboot-required; else echo none; fi"
      )
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
  | "retired"
  | "verified"
export type Entry = {
  name: Target
  validUntil: string | null
  outcome: Outcome
  /** Content-free explanation: check names, counts and states only. */
  detail?: string
  /** Content-free service health problems, gathered on every run. */
  health?: string[]
}
export type Report = {
  version: 1
  generatedAt: string
  assignee?: string
  registrations: Entry[]
  /** Machine notes for the issue body (uptime, pending restart). */
  machine?: string[]
}

/** Problems that need a person, judged at `now`. Only Azure registrations alert. */
export function problems(report: Report | null, now: Date): string[] {
  if (!report) return ["The renewal job on the Mac has never reported."]
  const out: string[] = []
  const age = now.getTime() - Date.parse(report.generatedAt)
  // The earliest watched expiry; with nothing watched, silence always alerts.
  const watched = report.registrations.filter((e) => isWatched(e.name))
  const soonest = watched.length
    ? Math.min(
        ...watched.map((e) =>
          e.validUntil ? Date.parse(e.validUntil) : -Infinity
        )
      )
    : -Infinity
  if (
    !(age <= STALE_REPORT_MS) &&
    soonest - now.getTime() <= STALE_MATTERS_WITHIN_MS
  )
    out.push(
      `The renewal job on the Mac has not reported since ${utc(report.generatedAt)}. Wake the Mac or run \`pnpm staging:reverify --renew --publish\`.`
    )
  for (const entry of report.registrations.filter((e) => isWatched(e.name))) {
    const detail = entry.detail ? ` (${entry.detail})` : ""
    if (entry.outcome === "failed")
      out.push(
        `${entry.name}: verification failed${detail}. It was not renewed.`
      )
    else if (
      entry.outcome === "missing" ||
      entry.outcome === "revoked" ||
      entry.outcome === "retired"
    )
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
    for (const line of entry.health ?? []) out.push(`${entry.name}: ${line}.`)
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
    "Staging on `vm-agents-01` stops working when its registrations expire or its services stop. The renewal job on the Mac normally renews registrations automatically; something below needs a person.",
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
    ...(report?.machine?.length
      ? ["**vm-agents-01**", ...report.machine.map((note) => `- ${note}`), ""]
      : []),
    "**To fix**, on the Mac: `pnpm staging:reverify` shows the state; `pnpm staging:reverify --renew --publish` re-verifies and renews. A failed check means the installation no longer matches what was reviewed: investigate before reinstalling. For a waiting or failed service, read its journal on the VM (`journalctl -u <unit>`); every line names a category.",
    "",
    `_Checked ${utc(now.toISOString())}. This issue closes itself once everything is valid again._`,
  ].join("\n")
}
