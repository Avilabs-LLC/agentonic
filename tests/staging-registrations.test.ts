import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// @ts-expect-error -- plain ESM script without type declarations
import * as units from "../scripts/staging-units.mjs"
import {
  DAY,
  HOUR,
  backupFindings,
  backupNote,
  ISSUE_MARKER,
  NODE,
  azureEvaluatorChecks,
  azureHostChecks,
  localHostChecks,
  failedChecks,
  gatherScript,
  healthFindings,
  healthProbes,
  issueBody,
  machineNotes,
  releaseNotes,
  parseFacts,
  planRenewal,
  problems,
  type Check,
  type Facts,
  type Registration,
  type Report,
} from "../scripts/staging-registrations/policy"

const now = new Date("2026-10-10T12:00:00Z")
const hash = (c: string) => c.repeat(64)
const registration = (
  ageMs: number,
  extra: Partial<Registration> = {}
): Registration => ({
  id: "10000000-0000-4000-8000-000000000001",
  verifiedAt: new Date(now.getTime() - ageMs).toISOString(),
  revokedAt: null,
  runtimes: [hash("b")],
  codeSha256: hash("a"),
  ...extra,
})

describe("renewal plan", () => {
  it("keeps valid registrations alone until two days before expiry", () => {
    expect(
      planRenewal({
        target: "azure-host",
        registration: registration(4 * DAY),
        now,
      })
    ).toEqual({ renew: false, reason: "not_due" })
    expect(
      planRenewal({
        target: "azure-host",
        registration: registration(5 * DAY + HOUR),
        now,
      })
    ).toEqual({ renew: true, reason: "due" })
    expect(
      planRenewal({
        target: "local-evaluator",
        registration: registration(6 * DAY),
        now,
      })
    ).toEqual({ renew: true, reason: "due" })
    expect(
      planRenewal({
        target: "azure-host",
        registration: registration(DAY),
        now,
        anyTime: true,
      })
    ).toEqual({ renew: true, reason: "requested" })
  })
  it("recovers expired Azure registrations but revives local ones only on request", () => {
    expect(
      planRenewal({
        target: "azure-evaluator",
        registration: registration(8 * DAY),
        now,
      })
    ).toEqual({ renew: true, reason: "expired" })
    expect(
      planRenewal({
        target: "local-host",
        registration: registration(8 * DAY),
        now,
      })
    ).toEqual({ renew: false, reason: "expired_local" })
    expect(
      planRenewal({
        target: "local-host",
        registration: registration(8 * DAY),
        now,
        selected: ["local-host"],
      })
    ).toEqual({ renew: true, reason: "expired" })
    expect(
      planRenewal({
        target: "azure-host",
        registration: registration(8 * DAY),
        now,
        selected: ["local-host"],
      })
    ).toEqual({ renew: false, reason: "not_selected" })
  })
  it("never revives revoked or missing registrations", () => {
    expect(
      planRenewal({
        target: "azure-host",
        registration: registration(6 * DAY, { revokedAt: now.toISOString() }),
        now,
        anyTime: true,
      })
    ).toEqual({ renew: false, reason: "revoked" })
    // A retired evaluator registration was succeeded by a new one; it is never renewed.
    expect(
      planRenewal({
        target: "azure-evaluator",
        registration: registration(6 * DAY, { retiredAt: now.toISOString() }),
        now,
        anyTime: true,
      })
    ).toEqual({ renew: false, reason: "retired" })
    expect(
      planRenewal({ target: "azure-host", registration: null, now })
    ).toEqual({ renew: false, reason: "missing" })
  })
})

const files = {
  "src/surfaces/preview.mjs": hash("c"),
  "prompts/platform.md": hash("d"),
}
/** Facts a correct installation reports, derived from the checks themselves. */
function healthy(checks: Check[], overrides: Facts = {}): Facts {
  const facts: Facts = {}
  for (const check of checks) {
    if (typeof check.expect === "string") facts[check.key] = check.expect
    else if (check.key.startsWith("stat:"))
      facts[check.key] = check.key.endsWith(".env")
        ? "root:root:600"
        : check.key.includes("/etc/agentonic")
          ? "root:root:700"
          : check.key.endsWith(".mjs")
            ? "root:root:444"
            : "root:root:644"
    else if (check.key.startsWith("unit:"))
      facts[check.key] =
        "ActiveState=active|DropInPaths=|UnitFileState=enabled|NeedDaemonReload=no|"
    else if (check.key.startsWith("env:") && check.key.endsWith("RUNTIME_ROOT"))
      facts[check.key] = '"/opt/agentonic/runtime/artifacts"'
    else if (check.key.startsWith("env:")) facts[check.key] = `"${hash("a")}"`
    else if (check.key === "cmdline:agentonic-deployer-staging.service")
      facts[check.key] =
        `${NODE} /opt/agentonic/staging/releases/${hash("a")}/broker.mjs --manager`
    else if (check.key === "cmdline:agentonic-gateway-staging.service")
      facts[check.key] =
        `${NODE} /opt/agentonic/staging/releases/${hash("a")}/broker.mjs --gateway`
    else if (check.key === "cmdline:agentonic-evaluator-staging.service")
      facts[check.key] =
        `${NODE} /opt/agentonic/evaluation/releases/${hash("a")}/worker.mjs`
    else if (check.key === "instances") facts[check.key] = "listed"
    else if (
      check.key.startsWith("sha:") &&
      check.key.endsWith("staging@.service")
    )
      facts[check.key] = ""
  }
  facts[`stat:${NODE}`] = "root:root:755"
  return { ...facts, ...overrides }
}

describe("installation checks", () => {
  const host = azureHostChecks({
    brokerSha256: hash("a"),
    brokers: [
      { sha256: hash("a"), templateSha256: hash("e") },
      { sha256: hash("6"), templateSha256: hash("5") },
    ],
    runtimes: [
      { sha256: hash("b"), files },
      { sha256: hash("7"), files },
    ],
    controllerUnitSha256: hash("f"),
    gatewayUnitSha256: hash("1"),
    gatewaySocketSha256: hash("2"),
  })
  const evaluator = azureEvaluatorChecks({
    workerSha256: hash("a"),
    runtimes: [{ sha256: hash("b"), files }],
    unitSha256: hash("e"),
  })

  it("passes an unchanged installation", () => {
    expect(failedChecks(host, healthy(host))).toEqual([])
    expect(failedChecks(evaluator, healthy(evaluator))).toEqual([])
  })
  it("names each deviation from the reviewed installation", () => {
    const broker = `sha:/opt/agentonic/staging/releases/${hash("a")}/broker.mjs`
    expect(failedChecks(host, healthy(host, { [broker]: hash("9") }))).toEqual([
      "broker aaaaaaaaaaaa program hash",
    ])
    // An earlier broker release still running copies is checked on its own.
    expect(
      failedChecks(
        host,
        healthy(host, {
          [`sha:/etc/systemd/system/agentonic-staging-${hash("6")}@.service`]:
            hash("9"),
        })
      )
    ).toEqual(["broker 666666666666 agent service template"])
    expect(
      failedChecks(
        host,
        healthy(host, {
          "sha:/etc/systemd/system/agentonic-staging@.service": hash("9"),
        })
      )
    ).toEqual(["no shared agent service template"])
    expect(
      failedChecks(
        host,
        healthy(host, {
          "stat:/etc/agentonic/staging/broker.env": "root:root:644",
        })
      )
    ).toEqual(["broker.env private"])
    expect(
      failedChecks(
        host,
        healthy(host, {
          "unit:agentonic-deployer-staging.service":
            "UnitFileState=enabled|NeedDaemonReload=no|DropInPaths=/etc/systemd/system/x.conf|",
        })
      )
    ).toEqual(["agentonic-deployer-staging.service unit loaded as installed"])
    const copy = (broker: string) =>
      `instance:agentonic-staging-${broker}@10000000-0000-4000-8000-000000000001.service`
    const program = (broker: string) =>
      `${NODE} /opt/agentonic/staging/releases/${broker}/broker.mjs`
    // Copies of every live broker run side by side, each its own release's program.
    expect(
      failedChecks(
        host,
        healthy(host, {
          [copy(hash("a"))]: program(hash("a")),
          [copy(hash("6"))]: program(hash("6")),
        })
      )
    ).toEqual([])
    for (const deviation of [
      { [copy(hash("6"))]: program(hash("a")) },
      { [copy(hash("8"))]: program(hash("8")) },
      { "instance:agentonic-staging@x.service": `${NODE} /tmp/broker.mjs` },
    ])
      expect(failedChecks(host, healthy(host, deviation))).toEqual([
        "agent services run registered brokers",
      ])
    expect(
      failedChecks(host, healthy(host, { [`stat:${NODE}`]: "root:root:777" }))
    ).toEqual(["Node binary protected"])
    // Every runtime installed side by side is checked and named on its own.
    expect(
      failedChecks(
        host,
        healthy(host, {
          [`sha:/opt/agentonic/runtime/artifacts/${hash("7")}/src/surfaces/preview.mjs`]:
            hash("9"),
        })
      )
    ).toEqual(["runtime 777777777777 file src/surfaces/preview.mjs"])
    expect(
      failedChecks(
        evaluator,
        healthy(evaluator, {
          "canread:agentonic-eval:/etc/agentonic/evaluation-staging/worker.env":
            "yes",
        })
      )
    ).toEqual(["evaluator cannot read its secrets file"])
    expect(
      failedChecks(evaluator, healthy(evaluator, { listeners: "1" }))
    ).toEqual(["no listening Node process"])
    // Passwords and keys stay with the gateway; agent configuration holds none.
    const config = "/etc/agentonic/staging"
    expect(
      failedChecks(
        host,
        healthy(host, { [`secrets:${config}/broker.env`]: "1" })
      )
    ).toEqual(["agent copies get no password or key"])
    expect(
      failedChecks(
        host,
        healthy(host, { [`secrets:${config}/agents/${hash("a")}`]: "2" })
      )
    ).toEqual(["current broker's copies hold no password or key"])
    expect(
      failedChecks(
        host,
        healthy(host, {
          [`defines:${config}/gateway.env#OPENAI_API_KEY`]: "no",
        })
      )
    ).toEqual(["gateway holds OPENAI_API_KEY"])
  })
  it("counts passwords and keys without ever reading them", () => {
    const dir = mkdtempSync(join(tmpdir(), "secrets-"))
    try {
      mkdirSync(join(dir, "agents"))
      writeFileSync(
        join(dir, "broker.env"),
        'AGENTONIC_RERANK_ENABLED="false"\nOPENAI_API_KEY="zz-visible-zz"\n'
      )
      writeFileSync(join(dir, "agents", "a.env"), 'DATABASE_URL=""\nX="1"\n')
      writeFileSync(
        join(dir, "agents", "b.env"),
        'GOOGLE_CLIENT_SECRET="zz-hidden-zz"\n'
      )
      writeFileSync(
        join(dir, "gateway.env"),
        'OPENAI_API_KEY="zz-gateway-zz"\nVOYAGE_API_KEY=""\n'
      )
      const keys = [
        `secrets:${dir}/broker.env`,
        `secrets:${dir}/agents`,
        `secrets:${dir}/missing`,
        `defines:${dir}/gateway.env#OPENAI_API_KEY`,
        `defines:${dir}/gateway.env#VOYAGE_API_KEY`,
      ]
      const output = execFileSync("bash", [
        "-c",
        gatherScript(keys.map((key) => ({ key }))),
      ]).toString()
      expect(output).not.toMatch(/zz-/)
      expect(parseFacts(output)).toEqual({
        [keys[0]!]: "1",
        [keys[1]!]: "1",
        [keys[2]!]: "0",
        [keys[3]!]: "yes",
        [keys[4]!]: "no",
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // The probe that prints a value refuses every password and key name.
    expect(() =>
      gatherScript([
        { key: "env:/etc/agentonic/staging/gateway.env#DATABASE_URL" },
      ])
    ).toThrow("Secret value")
  })
  it("fails closed when a fact is missing", () => {
    const facts = healthy(evaluator)
    delete facts.hostname
    expect(failedChecks(evaluator, facts)).toEqual(["host identity"])
  })
  it("accepts a stopped controller; recovery is checked after renewal", () => {
    expect(
      failedChecks(
        host,
        healthy(host, { "cmdline:agentonic-deployer-staging.service": "none" })
      )
    ).toEqual([])
  })
  it("gathers each fact once and refuses unsafe input", () => {
    const script = gatherScript(host)
    expect(script.match(/^f 'hostname'/gm)).toHaveLength(1)
    expect(() =>
      azureHostChecks({
        brokerSha256: "a'; reboot #",
        brokers: [{ sha256: "a'; reboot #", templateSha256: hash("e") }],
        runtimes: [{ sha256: hash("b"), files }],
        controllerUnitSha256: hash("f"),
        gatewayUnitSha256: hash("1"),
        gatewaySocketSha256: hash("2"),
      })
    ).toThrow()
    expect(() =>
      azureHostChecks({
        brokerSha256: hash("a"),
        runtimes: [
          { sha256: hash("b"), files: { "../../etc/shadow": hash("c") } },
        ],
        brokers: [{ sha256: hash("a"), templateSha256: hash("e") }],
        controllerUnitSha256: hash("f"),
        gatewayUnitSha256: hash("1"),
        gatewaySocketSha256: hash("2"),
      })
    ).toThrow()
    expect(() =>
      azureHostChecks({
        brokerSha256: hash("a"),
        runtimes: [{ sha256: hash("b"), files: { "x'$(id)": hash("c") } }],
        brokers: [{ sha256: hash("a"), templateSha256: hash("e") }],
        controllerUnitSha256: hash("f"),
        gatewayUnitSha256: hash("1"),
        gatewaySocketSha256: hash("2"),
      })
    ).toThrow()
  })
  it("checks the local gateway configuration only where it exists", () => {
    const local = localHostChecks({
      root: "/repo",
      brokerSha256: hash("a"),
      brokers: [hash("a")],
      runtimes: [],
    })
    const config = "/repo/.local/staging/config"
    const facts: Facts = {
      [`sha:/repo/.local/staging/releases/${hash("a")}/broker.mjs`]: hash("a"),
    }
    for (const file of ["broker.env", "manager.env", "gateway.env"]) {
      facts[`mode:${config}/${file}`] = "600"
      facts[`env:${config}/${file}#AGENTONIC_BROKER_SHA256`] = `"${hash("a")}"`
    }
    expect(failedChecks(local, facts)).toEqual([])
    // An installation from before the gateway has no gateway.env.
    const older = {
      ...facts,
      [`mode:${config}/gateway.env`]: "missing",
      [`env:${config}/gateway.env#AGENTONIC_BROKER_SHA256`]: undefined,
    } as Facts
    expect(failedChecks(local, older)).toEqual([])
    expect(
      failedChecks(local, {
        ...facts,
        [`mode:${config}/gateway.env`]: "644",
        [`env:${config}/gateway.env#AGENTONIC_BROKER_SHA256`]: `"${hash("b")}"`,
      })
    ).toEqual(["gateway.env private", "gateway.env pins the current broker"])
  })
  it("parses gathered output", () => {
    expect(
      parseFacts("hostname\tvm-agents-01\nlisteners\t0 \n\nnoise")
    ).toEqual({ hostname: "vm-agents-01", listeners: "0" })
  })
})

describe("service health", () => {
  const unit = "agentonic-deployer-staging.service"
  const gateway = "agentonic-gateway-staging.service"
  const running = "ActiveState=active|Result=success|NRestarts=0|"
  it("gathers health facts with fixed, safe commands", () => {
    const script = gatherScript([
      ...healthProbes("azure-host"),
      ...healthProbes("azure-evaluator"),
    ])
    expect(script).toContain(`journalctl -u ${unit} -o cat`)
    expect(script.match(/^f 'boot'/gm)).toHaveLength(1)
  })
  it("reports a stopped, waiting or failing service without content", () => {
    expect(
      healthFindings("azure-host", {
        [`state:${unit}`]: running,
        [`event:${unit}`]:
          '{"event":"service_recovered","reason":"database_unreachable"}',
        [`state:${gateway}`]: running,
        failedagents: "0",
      })
    ).toEqual([])
    expect(
      healthFindings("azure-host", {
        [`state:${unit}`]: "ActiveState=active|Result=success|NRestarts=0|",
        [`event:${unit}`]: JSON.stringify({
          event: "service_waiting",
          service: "deployment-controller",
          reason: "registration_refused",
          since: "2026-10-05T07:32:30.000Z",
        }),
        [`state:${gateway}`]: running,
        [`event:${gateway}`]: JSON.stringify({
          event: "service_waiting",
          service: "database-gateway",
          reason: "database_unreachable",
          since: "2026-10-05T07:33:00.000Z",
        }),
        failedagents: "2",
      })
    ).toEqual([
      "the deployment controller is waiting since 2026-10-05 07:32 UTC: the database refuses its registration (expired, replaced or revoked)",
      "the database gateway is waiting since 2026-10-05 07:33 UTC: the database is unreachable",
      "2 agent services have failed",
    ])
    expect(
      healthFindings("azure-host", {
        [`state:${unit}`]: running,
        [`state:${gateway}`]:
          "ActiveState=failed|Result=exit-code|NRestarts=5|",
        failedagents: "0",
      })
    ).toEqual([
      "the database gateway is not running (failed, exit-code, 5 restarts)",
    ])
    expect(
      healthFindings("azure-evaluator", {
        "state:agentonic-evaluator-staging.service":
          "ActiveState=failed|Result=start-limit-hit|NRestarts=5|",
        "event:agentonic-evaluator-staging.service":
          '{"event":"service_waiting","reason":"<script>"}',
      })
    ).toEqual([
      "the evaluator is not running (failed, start-limit-hit, 5 restarts)",
    ])
    expect(healthFindings("azure-host", {})).toEqual([
      "could not read the state of the deployment controller",
      "could not read the state of the database gateway",
    ])
  })
  it("checks the planned restart window against the reviewed units", () => {
    const window = { timerSha256: hash("1"), serviceSha256: hash("2") }
    const timer = "agentonic-restart-window.timer"
    const facts = {
      [`state:${unit}`]: running,
      [`state:${gateway}`]: running,
      failedagents: "0",
      [`sha:/etc/systemd/system/${timer}`]: hash("1"),
      "sha:/etc/systemd/system/agentonic-restart-window.service": hash("2"),
      [`state:${timer}`]: "ActiveState=active|Result=success|NRestarts=0|",
    }
    expect(healthFindings("azure-host", facts, window)).toEqual([])
    expect(
      healthFindings(
        "azure-host",
        { ...facts, [`sha:/etc/systemd/system/${timer}`]: "" },
        window
      )
    ).toEqual([
      "the planned restart window is not installed as reviewed (`pnpm staging:restart-window`)",
    ])
    expect(
      healthFindings(
        "azure-host",
        { ...facts, [`state:${timer}`]: "ActiveState=inactive|" },
        window
      )
    ).toEqual(["the planned restart window is not active"])
    expect(() => gatherScript([{ key: "next:x;reboot.service" }])).toThrow()
    expect(gatherScript([{ key: `next:${timer}` }])).toContain(
      `NextElapseUSecRealtime --value ${timer}`
    )
  })
  it("notes restarts and pending updates without alerting", () => {
    const boot = String(Math.floor((now.getTime() - 3 * HOUR) / 1000))
    expect(machineNotes({ boot, reboot: "none" }, now)).toEqual([
      "vm-agents-01 has been up since 2026-10-10 09:00 UTC (restarted within the last day).",
    ])
    expect(
      machineNotes(
        {
          boot: String(Math.floor((now.getTime() - 9 * DAY) / 1000)),
          reboot: String(Math.floor((now.getTime() - 2 * DAY) / 1000)),
        },
        now
      )[1]
    ).toContain("waiting for a restart since 2026-10-08 12:00 UTC")
    expect(
      machineNotes(
        {
          reboot: String(Math.floor((now.getTime() - DAY) / 1000)),
          "next:agentonic-restart-window.timer": "2026-10-11T03:00:00Z",
        },
        now
      )[0]
    ).toContain(
      "The planned restart window applies them on 2026-10-11 03:00 UTC."
    )
  })
})

describe("VM backups", () => {
  const backup = (ageMs: number | null, extra = {}) => ({
    protectionState: "Protected",
    lastBackupStatus: "Completed",
    lastBackupTime:
      ageMs === null
        ? "2001-01-01T00:00:00+00:00"
        : new Date(now.getTime() - ageMs).toISOString(),
    ...extra,
  })
  it("stays quiet while daily backups complete", () => {
    expect(backupFindings(backup(10 * HOUR), now)).toEqual([])
    expect(backupNote(backup(10 * HOUR))).toBe(
      "Last VM backup: 2026-10-10 02:00 UTC."
    )
  })
  it("alerts on a missed day, a failure, stopped protection or a lost sign-in", () => {
    expect(backupFindings(backup(40 * HOUR), now)).toEqual([
      "the last VM backup is from 2026-10-08 20:00 UTC",
    ])
    expect(
      backupFindings(backup(10 * HOUR, { lastBackupStatus: "Failed" }), now)
    ).toEqual(["the last VM backup failed"])
    expect(
      backupFindings(
        backup(10 * HOUR, { protectionState: "ProtectionStopped" }),
        now
      )
    ).toEqual(["VM backups are not active (ProtectionStopped)"])
    expect(
      backupFindings(
        backup(null, { protectionState: "IRPending", lastBackupStatus: "" }),
        now
      )
    ).toEqual(["no VM backup has completed yet"])
    expect(backupNote(backup(null))).toBeNull()
    expect(backupFindings(null, now)).toEqual([
      "could not check the VM backups; sign in again with `az login` on the Mac",
    ])
  })
})

describe("alerts", () => {
  const report = (
    entries: Report["registrations"],
    generatedAt = now.toISOString()
  ): Report => ({ version: 1, generatedAt, registrations: entries })
  const later = (ms: number) => new Date(now.getTime() + ms).toISOString()

  it("stays quiet while Azure registrations are valid, whatever local ones do", () => {
    expect(
      problems(
        report([
          {
            name: "azure-host",
            validUntil: later(5 * DAY),
            outcome: "renewed",
          },
          {
            name: "azure-evaluator",
            validUntil: later(3 * DAY),
            outcome: "valid",
          },
          {
            name: "local-host",
            validUntil: later(-9 * DAY),
            outcome: "expired",
          },
        ]),
        now
      )
    ).toEqual([])
  })
  it("alerts on failure, missing, expiring and expired Azure registrations", () => {
    const found = problems(
      report([
        {
          name: "azure-host",
          validUntil: later(5 * DAY),
          outcome: "failed",
          detail: "broker program hash",
        },
        {
          name: "azure-evaluator",
          validUntil: later(12 * HOUR),
          outcome: "deferred",
          detail: "an evaluation is in progress",
        },
      ]),
      now
    )
    expect(found).toHaveLength(2)
    expect(found[0]).toContain("verification failed (broker program hash)")
    expect(found[1]).toContain(
      "expires at 2026-10-11 00:00 UTC (an evaluation is in progress)"
    )
    expect(
      problems(
        report([{ name: "azure-host", validUntil: null, outcome: "missing" }]),
        now
      )[0]
    ).toContain("no active registration")
    expect(
      problems(
        report([
          { name: "azure-host", validUntil: later(-HOUR), outcome: "expired" },
        ]),
        now
      )[0]
    ).toContain("expired at")
    expect(
      problems(
        report([
          {
            name: "azure-host",
            validUntil: later(7 * DAY),
            outcome: "renewed",
            detail: "the deployment controller has not resumed within 60 s",
          },
        ]),
        now
      )[0]
    ).toContain("renewed, but")
  })
  it("alerts on unhealthy Azure services even while registrations are valid", () => {
    const found = problems(
      report([
        {
          name: "azure-host",
          validUntil: later(5 * DAY),
          outcome: "valid",
          health: ["2 agent services have failed"],
        },
        {
          name: "local-host",
          validUntil: later(5 * DAY),
          outcome: "valid",
          health: ["ignored for local registrations"],
        },
      ]),
      now
    )
    expect(found).toEqual(["azure-host: 2 agent services have failed."])
    expect(
      problems(
        report([
          { name: "azure-evaluator", validUntil: null, outcome: "retired" },
        ]),
        now
      )[0]
    ).toContain("no active registration (retired)")
  })
  it("treats a deferred renewal with time left as quiet", () => {
    expect(
      problems(
        report([
          {
            name: "azure-evaluator",
            validUntil: later(40 * HOUR),
            outcome: "deferred",
            detail: "an evaluation is in progress",
          },
        ]),
        now
      )
    ).toEqual([])
  })
  it("alerts when the Mac stops reporting, judged by the time of the check", () => {
    expect(problems(null, now)).toEqual([
      "The renewal job on the Mac has never reported.",
    ])
    const old = report(
      [{ name: "azure-host", validUntil: later(5 * DAY), outcome: "renewed" }],
      later(-37 * HOUR)
    )
    expect(problems(old, now)[0]).toContain("has not reported since")
    // A report that was healthy becomes an expiry alert as time passes.
    const fresh = report([
      { name: "azure-host", validUntil: later(30 * HOUR), outcome: "valid" },
    ])
    expect(problems(fresh, new Date(now.getTime() + 8 * HOUR))).toHaveLength(1)
  })
  it("writes a marked, content-free issue body", () => {
    const body = issueBody(
      report([
        { name: "azure-host", validUntil: later(HOUR), outcome: "valid" },
      ]),
      ["azure-host: expires soon."],
      now
    )
    expect(body.startsWith(ISSUE_MARKER)).toBe(true)
    expect(body).toContain("| azure-host | 2026-10-10 13:00 UTC | valid |")
    expect(
      issueBody(
        { ...report([]), machine: ["vm-agents-01 has been up since X."] },
        [],
        now
      )
    ).toContain("**vm-agents-01**\n- vm-agents-01 has been up since X.")
    expect(body).not.toMatch(/[a-f0-9]{64}/)
  })
})

describe("agent service templates", () => {
  const unitsFor = (broker: string) =>
    units.stagingUnits({
      broker,
      serviceRoot: "/etc/agentonic/staging/agents",
      caPath: "/etc/agentonic/staging/database-ca.crt",
      configRoot: "/etc/agentonic/staging",
    }) as Record<string, string>
  it("runs new copies without network, password or key", () => {
    const { runtime, gateway } = unitsFor(hash("a"))
    expect(runtime).toContain("PrivateNetwork=yes\n")
    expect(runtime).toContain("IPAddressDeny=any\n")
    expect(runtime).toContain("RestrictAddressFamilies=AF_UNIX\n")
    expect(runtime).not.toMatch(/AF_INET|LoadCredential=ca:|DATABASE/)
    // The gateway reaches the database and providers, never private networks or host endpoints.
    expect(gateway).toContain("IPAddressDeny=10.0.0.0/8 ")
    expect(gateway).toMatch(
      /IPAddressDeny=.* 169\.254\.0\.0\/16 168\.63\.129\.16 /
    )
  })
  it("keeps the template of brokers whose copies still call providers themselves", () => {
    for (const broker of units.directProviderBrokers as Set<string>) {
      const { runtime } = unitsFor(broker)
      expect(runtime).toContain(
        "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\n"
      )
      expect(runtime).toContain("LoadCredential=ca:")
      expect(runtime).not.toContain("PrivateNetwork")
    }
  })
})

describe("what each environment runs", () => {
  const a = "a".repeat(64),
    b = "b".repeat(64),
    unknown = "c".repeat(64)
  const releases = [
    {
      sha256: a,
      version: "0.3.0-preview-f272ddaa",
      commit: "f272ddaa" + "0".repeat(32),
    },
    { sha256: b, version: "0.5.0", commit: "1234567" + "0".repeat(33) },
  ]
  it("names worker releases and runtimes by version and source commit", () => {
    expect(
      releaseNotes(
        {
          "azure-host": {
            codeSha256: "e".repeat(64),
            brokers: ["58d9a1f3" + "0".repeat(56), "2af81262" + "0".repeat(56)],
            runtimes: [b, a],
          },
          "azure-evaluator": {
            codeSha256: "c0fdd72d" + "0".repeat(56),
            runtimes: [unknown],
          },
          "local-host": null,
        },
        releases
      )
    ).toEqual([
      "azure-host runs worker 58d9a1f3, 2af81262; runtimes 0.3.0-preview-f272ddaa, 0.5.0 (1234567).",
      `azure-evaluator runs worker c0fdd72d; runtimes ${unknown.slice(0, 12)}.`,
    ])
  })
})
