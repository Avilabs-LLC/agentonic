import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import {
  readFileSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  root,
  loadLocal,
  writeLocal,
  connect,
  bootstrapConfig,
  fail,
} from "./local-config.mjs"
import {
  agentTemplate,
  controllerRules,
  controllerRulesPath,
  controllerUser,
  dropInBrokers,
  gatewayGroup,
  gatewaySocket,
  gatewayUnit,
  stagingNode,
  stagingReleases,
  stagingUnits,
} from "./staging-units.mjs"
// Installs the private staging deployment controller, the host's gateway and an agent
// service template for the packaged broker. The controller runs as its own user, not
// root (architecture §47). Brokers install side by side: running
// deployments keep their copies, and the new controller moves them to this broker one
// at a time without interrupting a turn. Agent copies started from this broker reach
// the database and every provider only through the gateway: they hold no database
// password, provider key or Gmail key, and run without network access.
// Existing evaluators, Corby services, public ports and provider budgets are untouched.
const azure = process.argv.includes("--azure"),
  local = process.argv.includes("--local")
assert.ok(azure !== local, "Choose --local or --azure")
assert.equal(bootstrapConfig().ref, "jkgdxkacariasunhentd")
const packaged = JSON.parse(
  execFileSync(process.execPath, [join(root, "scripts/package-staging.mjs")], {
    cwd: root,
  }).toString()
)
const runtimeHash = process.argv
  .find((x) => x.startsWith("--runtime-sha256="))
  ?.split("=")[1]
assert.match(
  runtimeHash ?? "",
  /^[a-f0-9]{64}$/,
  "Supply the existing frozen runtime hash"
)
const sha = (x) => createHash("sha256").update(x).digest("hex")
const runtimeSource = join(root, ".local/runtime", runtimeHash)
assert.equal(
  sha(readFileSync(join(runtimeSource, "manifest.json"))),
  runtimeHash
)
const runtimeManifest = JSON.parse(
  readFileSync(join(runtimeSource, "manifest.json"))
)
for (const [file, hash] of Object.entries(runtimeManifest.files))
  assert.equal(sha(readFileSync(join(runtimeSource, file))), hash)
const credentials = loadLocal(".env.staging.local"),
  keys = loadLocal("apps/worker/.env.local")
const workspace = join(root, ".local/staging")
mkdirSync(workspace, { recursive: true, mode: 0o700 })
const instanceRoot = azure
  ? "/opt/agentonic/instances"
  : join(workspace, "instances")
const runtimeRoot = azure
  ? "/opt/agentonic/runtime/artifacts"
  : join(root, ".local/runtime")
const configRoot = azure ? "/etc/agentonic/staging" : join(workspace, "config")
const serviceRoot = join(configRoot, "agents")
const release = azure
  ? `${stagingReleases}/${packaged.brokerHash}`
  : packaged.directory
const caPath = azure
  ? join(configRoot, "database-ca.crt")
  : credentials.AGENTONIC_DATABASE_CA_FILE
const suffix = azure ? "AZURE" : "LOCAL"
const socketPath = azure ? gatewaySocket : join(workspace, "gateway.sock")
// Every agent copy's configuration starts from broker.env: no password and no key.
const broker = {
  AGENTONIC_GATEWAY_SOCKET: socketPath,
  AGENTONIC_RUNTIME_ROOT: runtimeRoot,
  AGENTONIC_INSTANCE_ROOT: instanceRoot,
  AGENTONIC_BROKER_SHA256: packaged.brokerHash,
  AGENTONIC_RERANK_ENABLED:
    keys.AGENTONIC_RERANK_ENABLED === "true" ? "true" : "false",
}
const manager = {
  DATABASE_URL: credentials[`AGENTONIC_DEPLOYER_${suffix}_DATABASE_URL`],
  AGENTONIC_DATABASE_CA_FILE: caPath,
  AGENTONIC_RUNTIME_ROOT: runtimeRoot,
  AGENTONIC_INSTANCE_ROOT: instanceRoot,
  AGENTONIC_BROKER_SHA256: packaged.brokerHash,
  AGENTONIC_SERVICE_CONFIG_ROOT: serviceRoot,
  AGENTONIC_BROKER_CONFIG: join(configRoot, "broker.env"),
}
// The gateway holds the runtime role's connections and the provider keys for every
// copy on the host. Optional providers are left out when not configured.
const gateway = {
  DATABASE_URL: credentials[`AGENTONIC_RUNTIME_${suffix}_DATABASE_URL`],
  AGENTONIC_DATABASE_CA_FILE: caPath,
  AGENTONIC_BROKER_SHA256: packaged.brokerHash,
  AGENTONIC_GATEWAY_CONNECTIONS: "5",
  // On Azure systemd hands the gateway its socket; locally it binds this private path.
  ...(local ? { AGENTONIC_GATEWAY_SOCKET: socketPath } : {}),
  OPENAI_API_KEY: keys.OPENAI_API_KEY,
  VOYAGE_API_KEY: keys.VOYAGE_API_KEY,
}
const optional = {
  ...(credentials.BROWSERBASE_API_KEY
    ? { BROWSERBASE_API_KEY: credentials.BROWSERBASE_API_KEY }
    : {}),
  ...(credentials.AGENTONIC_CONNECTION_KEY
    ? {
        GOOGLE_CLIENT_ID: credentials.GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: credentials.GOOGLE_CLIENT_SECRET,
        GOOGLE_REDIRECT_URI: credentials.GOOGLE_REDIRECT_URI,
        AGENTONIC_CONNECTION_KEY: credentials.AGENTONIC_CONNECTION_KEY,
        ...(credentials.AGENTONIC_CONNECTION_STANDBY_KEYS
          ? {
              AGENTONIC_CONNECTION_STANDBY_KEYS:
                credentials.AGENTONIC_CONNECTION_STANDBY_KEYS,
            }
          : {}),
      }
    : {}),
}
for (const value of Object.values({ ...broker, ...manager, ...gateway }))
  assert.ok(value, "Complete staging configuration required")
Object.assign(gateway, optional)
const staging = join(workspace, azure ? "azure-install" : "local-install")
mkdirSync(staging, { recursive: true, mode: 0o700 })
writeLocal(join(staging, "broker.env"), broker)
writeLocal(join(staging, "manager.env"), manager)
writeLocal(join(staging, "gateway.env"), gateway)
const ssh = (script) =>
  execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "vm-agents-01", "sudo", "-n", "bash", "-se"],
    { input: script, stdio: ["pipe", "pipe", "pipe"] }
  )
    .toString()
    .trim()
const UUID_ENV =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.env$/
let db
try {
  const migration = loadLocal(".env.database.local")
  db = await connect(
    migration.AGENTONIC_MIGRATION_DATABASE_URL,
    migration.AGENTONIC_DATABASE_CA_FILE
  )
  const existing = await db.query(
    "SELECT id,broker_sha256 FROM agentonic.runtime_hosts WHERE environment=$1",
    [azure ? "azure_staging" : "local"]
  )
  const hostId = existing.rows[0]?.id
  const registered = hostId
    ? (
        await db.query(
          "SELECT broker_sha256,retired_at,revoked_at FROM agentonic.runtime_host_brokers WHERE host_id=$1",
          [hostId]
        )
      ).rows
    : []
  assert.ok(
    !registered.some(
      (b) => b.broker_sha256 === packaged.brokerHash && b.revoked_at
    ),
    "This broker was revoked on this host and cannot return"
  )
  const retired = registered
    .filter((b) => b.retired_at && b.broker_sha256 !== packaged.brokerHash)
    .map((b) => b.broker_sha256)
  for (const hash of retired) assert.match(hash, /^[a-f0-9]{64}$/)
  // Earlier live brokers may still run copies; their templates are rewritten to the
  // current text, which keeps everything those copies use.
  const earlier = registered
    .filter(
      (b) =>
        !b.retired_at &&
        !b.revoked_at &&
        b.broker_sha256 !== packaged.brokerHash
    )
    .map((b) => b.broker_sha256)
  for (const hash of earlier) assert.match(hash, /^[a-f0-9]{64}$/)
  // Runtimes install side by side (see install-runtime.mjs).
  const installedRuntimes = hostId
    ? (
        await db.query(
          "SELECT runtime_sha256 FROM agentonic.runtime_host_artifacts WHERE host_id=$1 AND retired_at IS NULL",
          [hostId]
        )
      ).rows.map((r) => r.runtime_sha256)
    : []
  for (const hash of installedRuntimes) assert.match(hash, /^[a-f0-9]{64}$/)
  const activeDeployments = hostId
    ? (
        await db.query(
          "SELECT count(*)::int n FROM agentonic.deployments WHERE host_id=$1 AND status IN ('queued','preparing','running')",
          [hostId]
        )
      ).rows[0].n
    : 0
  // Before side-by-side brokers every agent service shared one template and kept its
  // configuration directly in the service directory. Replacing that layout still needs
  // its deployments stopped; later broker releases install next to running copies.
  const legacy = azure
    ? ssh(
        `test -e /etc/systemd/system/agentonic-staging@.service && echo legacy || true\n`
      ) === "legacy"
    : existsSync(serviceRoot) &&
      readdirSync(serviceRoot).some((name) => UUID_ENV.test(name))
  if (legacy)
    assert.equal(
      activeDeployments,
      0,
      "Stop deployments before the first side-by-side broker installation"
    )
  if (azure) {
    const upload = execFileSync(
      "ssh",
      [
        "vm-agents-01",
        "mktemp",
        "-d",
        "/tmp/agentonic-staging-install.XXXXXXXX",
      ],
      { stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .trim()
    assert.match(upload, /^\/tmp\/agentonic-staging-install\.[a-zA-Z0-9]{8}$/)
    const caName = credentials.AGENTONIC_DATABASE_CA_FILE.split("/").at(-1)
    assert.match(caName, /^[a-zA-Z0-9._-]+$/)
    const units = (hash) =>
      stagingUnits({ broker: hash, serviceRoot, caPath, configRoot })
    const current = units(packaged.brokerHash)
    writeFileSync(join(staging, "controller.service"), current.controller)
    writeFileSync(join(staging, "gateway.service"), current.gateway)
    writeFileSync(join(staging, "gateway.socket"), current.gatewaySocket)
    writeFileSync(join(staging, "controller.rules"), controllerRules)
    // This broker's controller runs as its own user (see staging-units.mjs).
    const unprivileged = !dropInBrokers.has(packaged.brokerHash)
    const templates = [packaged.brokerHash, ...earlier]
    for (const hash of templates)
      writeFileSync(
        join(staging, `runtime-${hash}.service`),
        units(hash).runtime
      )
    execFileSync(
      "scp",
      [
        "-q",
        join(packaged.directory, "broker.mjs"),
        join(staging, "broker.env"),
        join(staging, "manager.env"),
        join(staging, "gateway.env"),
        credentials.AGENTONIC_DATABASE_CA_FILE,
        ...templates.map((hash) => join(staging, `runtime-${hash}.service`)),
        join(staging, "controller.service"),
        join(staging, "gateway.service"),
        join(staging, "gateway.socket"),
        join(staging, "controller.rules"),
        `vm-agents-01:${upload}/`,
      ],
      { stdio: "ignore" }
    )
    const node = stagingNode
    // Only fixed paths, UUID/hash-derived destinations and reviewed program bytes are installed.
    ssh(
      [
        `test -x ${node}`,
        ...[...new Set([runtimeHash, ...installedRuntimes])].map(
          (hash) =>
            `test "$(sha256sum ${runtimeRoot}/${hash}/manifest.json | cut -d' ' -f1)" = '${hash}'`
        ),
        `test "$(sha256sum ${upload}/broker.mjs | cut -d' ' -f1)" = '${packaged.brokerHash}'`,
        `install -d -m 755 ${release}`,
        `install -d -m 700 ${instanceRoot} ${configRoot} ${serviceRoot}`,
        `install -m 444 ${upload}/broker.mjs ${release}/broker.mjs`,
        `install -m 600 ${upload}/broker.env ${configRoot}/broker.env`,
        `install -m 600 ${upload}/manager.env ${configRoot}/manager.env`,
        `install -m 600 ${upload}/gateway.env ${configRoot}/gateway.env`,
        `install -m 644 ${upload}/${caName} ${caPath}`,
        // Only agent copies (and root) may open the gateway's socket.
        `getent group ${gatewayGroup} >/dev/null || groupadd --system ${gatewayGroup}`,
        ...templates.map(
          (hash) =>
            `install -m 644 ${upload}/runtime-${hash}.service /etc/systemd/system/${agentTemplate(hash)}`
        ),
        `install -m 644 ${upload}/controller.service /etc/systemd/system/agentonic-deployer-staging.service`,
        `install -m 644 ${upload}/gateway.service /etc/systemd/system/${gatewayUnit}.service`,
        `install -m 644 ${upload}/gateway.socket /etc/systemd/system/${gatewayUnit}.socket`,
        // The controller's own user: it writes only the deployment files and agent
        // configurations, passes through the configuration directory without reading
        // it, and polkit lets it start, stop and reset agent copies only. Agent unit
        // drop-ins are no longer used; running copies keep what they loaded at start.
        ...(unprivileged
          ? [
              `id -u ${controllerUser} >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ${controllerUser}`,
              `install -m 644 ${upload}/controller.rules ${controllerRulesPath}`,
              `chown root:${controllerUser} ${configRoot}`,
              `chmod 710 ${configRoot}`,
              `chown -R ${controllerUser}:${controllerUser} ${instanceRoot} ${serviceRoot}`,
              `chmod 700 ${instanceRoot} ${serviceRoot}`,
              "find /etc/systemd/system -maxdepth 1 -name 'agentonic-staging-*@*.service.d' -exec rm -rf {} +",
            ]
          : []),
        // Retired brokers run no copies; their templates and empty configuration directories go.
        ...retired.map(
          (hash) =>
            `rm -f /etc/systemd/system/${agentTemplate(hash)}; rmdir ${serviceRoot}/${hash} 2>/dev/null || true`
        ),
        ...(legacy
          ? [
              "rm -f /etc/systemd/system/agentonic-staging@.service",
              `find ${serviceRoot} -maxdepth 1 -type f -name '*.env' -delete`,
            ]
          : []),
        "systemctl daemon-reload",
        `rm -rf ${upload}`,
        "",
      ].join("\n")
    )
    assert.equal(
      ssh(`sha256sum ${release}/broker.mjs | cut -d' ' -f1`),
      packaged.brokerHash
    )
  } else {
    mkdirSync(serviceRoot, { recursive: true, mode: 0o700 })
    mkdirSync(instanceRoot, { recursive: true, mode: 0o700 })
    if (legacy)
      for (const name of readdirSync(serviceRoot))
        if (UUID_ENV.test(name)) rmSync(join(serviceRoot, name))
    writeLocal(join(configRoot, "broker.env"), broker)
    writeLocal(join(configRoot, "manager.env"), manager)
    writeLocal(join(configRoot, "gateway.env"), gateway)
  }
  await db.query("BEGIN")
  const host = (
    await db.query(
      `INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,verified_at) VALUES($1,$2,$3,clock_timestamp())
 ON CONFLICT(environment) DO UPDATE SET broker_sha256=excluded.broker_sha256,verified_at=excluded.verified_at,revoked_at=NULL RETURNING id`,
      [
        azure ? "azure_staging" : "local",
        azure ? "agentonic_deployer_azure" : "agentonic_deployer_local",
        packaged.brokerHash,
      ]
    )
  ).rows[0].id
  // Reinstalling a retired release brings it back; a revoked one never returns.
  await db.query(
    "INSERT INTO agentonic.runtime_host_brokers(host_id,broker_sha256) VALUES($1,$2) ON CONFLICT(host_id,broker_sha256) DO UPDATE SET retired_at=NULL WHERE runtime_host_brokers.revoked_at IS NULL",
    [host, packaged.brokerHash]
  )
  await db.query(
    "INSERT INTO agentonic.runtime_host_artifacts(host_id,runtime_sha256) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [host, runtimeHash]
  )
  assert.equal(
    (
      await db.query(
        "SELECT count(*)::int n FROM agentonic.runtime_host_artifacts WHERE host_id=$1 AND runtime_sha256=$2 AND retired_at IS NULL",
        [host, runtimeHash]
      )
    ).rows[0].n,
    1,
    "This runtime was retired on this host"
  )
  await db.query("COMMIT")
  // The gateway starts first so the new controller's copies find it.
  if (azure)
    ssh(
      [
        `systemctl enable --now ${gatewayUnit}.socket`,
        `systemctl enable ${gatewayUnit}.service`,
        `systemctl restart ${gatewayUnit}.service`,
        `systemctl is-active ${gatewayUnit}.service`,
        // Files the previous controller wrote as root until now become the new one's.
        ...(dropInBrokers.has(packaged.brokerHash)
          ? []
          : [
              "systemctl stop agentonic-deployer-staging.service",
              `chown -R ${controllerUser}:${controllerUser} ${instanceRoot} ${serviceRoot}`,
            ]),
        "systemctl enable --now agentonic-deployer-staging.service",
        "systemctl restart agentonic-deployer-staging.service",
        "systemctl is-active agentonic-deployer-staging.service",
        "",
      ].join("\n")
    )
  else {
    writeFileSync(
      join(workspace, "local-installation.json"),
      JSON.stringify({ release, config: join(configRoot, "manager.env") }) +
        "\n",
      { mode: 0o600 }
    )
    if (process.argv.includes("--start")) {
      // Fail if an existing gateway or controller is live instead of creating competing processes.
      const alive = (pidFile) => {
        if (!existsSync(pidFile)) return false
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), 0)
          return true
        } catch {
          /* A stale PID file does not indicate a running process. */
          return false
        }
      }
      for (const [name, flag, config] of [
        ["gateway", "--gateway", "gateway.env"],
        ["manager", "--manager", "manager.env"],
      ]) {
        const pidFile = join(workspace, `${name}.pid`)
        assert.ok(!alive(pidFile), `Local staging ${name} already running`)
        const child = spawn(
          process.execPath,
          [join(release, "broker.mjs"), flag],
          {
            env: {
              PATH: process.env.PATH,
              AGENTONIC_STAGING_CONFIG: join(configRoot, config),
            },
            detached: true,
            stdio: "ignore",
          }
        )
        child.unref()
        writeFileSync(pidFile, String(child.pid), { mode: 0o600 })
      }
    }
  }
  console.log(
    JSON.stringify({
      installed: true,
      environment: azure ? "azure_staging" : "local",
      brokerHash: packaged.brokerHash,
      runtimeHash,
      runningDeployments: activeDeployments,
      ...(activeDeployments && !legacy
        ? {
            note: "The controller moves running deployments to this broker one at a time.",
          }
        : {}),
    })
  )
} catch (error) {
  await db?.query("ROLLBACK").catch(() => {})
  fail(error)
} finally {
  await db?.end()
}
