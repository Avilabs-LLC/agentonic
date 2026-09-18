import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
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
// Installs only the private staging deployment controller and its runtime template.
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
  ? `/opt/agentonic/staging/releases/${packaged.brokerHash}`
  : packaged.directory
const caPath = azure
  ? join(configRoot, "database-ca.crt")
  : credentials.AGENTONIC_DATABASE_CA_FILE
const suffix = azure ? "AZURE" : "LOCAL"
const broker = {
  DATABASE_URL: credentials[`AGENTONIC_RUNTIME_${suffix}_DATABASE_URL`],
  AGENTONIC_DATABASE_CA_FILE: caPath,
  AGENTONIC_RUNTIME_ROOT: runtimeRoot,
  AGENTONIC_INSTANCE_ROOT: instanceRoot,
  AGENTONIC_BROKER_SHA256: packaged.brokerHash,
  OPENAI_API_KEY: keys.OPENAI_API_KEY,
  VOYAGE_API_KEY: keys.VOYAGE_API_KEY,
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
for (const value of Object.values({ ...broker, ...manager }))
  assert.ok(value, "Complete staging configuration required")
const staging = join(workspace, azure ? "azure-install" : "local-install")
mkdirSync(staging, { recursive: true, mode: 0o700 })
writeLocal(join(staging, "broker.env"), broker)
writeLocal(join(staging, "manager.env"), manager)
const ssh = (script) =>
  execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "vm-agents-01", "sudo", "-n", "bash", "-se"],
    { input: script, stdio: ["pipe", "pipe", "pipe"] }
  )
    .toString()
    .trim()
let db
try {
  const migration = loadLocal(".env.database.local")
  db = await connect(
    migration.AGENTONIC_MIGRATION_DATABASE_URL,
    migration.AGENTONIC_DATABASE_CA_FILE
  )
  const existing = await db.query(
    "SELECT id,broker_sha256,runtime_sha256 FROM agentonic.runtime_hosts WHERE environment=$1",
    [azure ? "azure_staging" : "local"]
  )
  if (
    existing.rowCount &&
    (existing.rows[0].broker_sha256 !== packaged.brokerHash ||
      existing.rows[0].runtime_sha256 !== runtimeHash)
  ) {
    const active = await db.query(
      "SELECT count(*)::int n FROM agentonic.deployments WHERE host_id=$1 AND status IN ('queued','preparing','running')",
      [existing.rows[0].id]
    )
    assert.equal(
      active.rows[0].n,
      0,
      "Stop deployments before replacing a broker"
    )
  }
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
    execFileSync(
      "scp",
      [
        "-q",
        join(packaged.directory, "broker.mjs"),
        join(staging, "broker.env"),
        join(staging, "manager.env"),
        credentials.AGENTONIC_DATABASE_CA_FILE,
        `vm-agents-01:${upload}/`,
      ],
      { stdio: "ignore" }
    )
    const caName = credentials.AGENTONIC_DATABASE_CA_FILE.split("/").at(-1)
    assert.match(caName, /^[a-zA-Z0-9._-]+$/)
    const node = "/opt/agentonic/node/v22.23.2/bin/node"
    const service = `[Unit]\nDescription=Agentonic private staging runtime %i\nAfter=network-online.target\nStartLimitIntervalSec=120\nStartLimitBurst=3\n[Service]\nType=simple\nDynamicUser=yes\nLoadCredential=config:${serviceRoot}/%i.env\nLoadCredential=ca:${caPath}\nEnvironment=AGENTONIC_DATABASE_CA_FILE=%d/ca\nExecStart=${node} ${release}/broker.mjs\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=15\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nCapabilityBoundingSet=\nMemoryMax=512M\nCPUQuota=100%\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n`
    const controller = `[Unit]\nDescription=Agentonic staging deployment controller\nAfter=network-online.target\n[Service]\nType=simple\nUser=root\nEnvironment=AGENTONIC_STAGING_CONFIG=${configRoot}/manager.env\nExecStart=${node} ${release}/broker.mjs --manager\nRestart=on-failure\nRestartSec=10\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nReadWritePaths=/opt/agentonic/instances ${serviceRoot} /etc/systemd/system\nMemoryMax=256M\nCPUQuota=50%\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`
    writeFileSync(join(staging, "runtime.service"), service)
    writeFileSync(join(staging, "controller.service"), controller)
    execFileSync(
      "scp",
      [
        "-q",
        join(staging, "runtime.service"),
        join(staging, "controller.service"),
        `vm-agents-01:${upload}/`,
      ],
      { stdio: "ignore" }
    )
    // Only fixed paths, UUID/hash-derived destinations and reviewed program bytes are installed.
    ssh(
      `test -x ${node}\ntest "$(sha256sum ${runtimeRoot}/${runtimeHash}/manifest.json | cut -d' ' -f1)" = '${runtimeHash}'\ntest "$(sha256sum ${upload}/broker.mjs | cut -d' ' -f1)" = '${packaged.brokerHash}'\ninstall -d -m 755 ${release}\ninstall -d -m 700 ${instanceRoot} ${configRoot} ${serviceRoot}\ninstall -m 444 ${upload}/broker.mjs ${release}/broker.mjs\ninstall -m 600 ${upload}/broker.env ${configRoot}/broker.env\ninstall -m 600 ${upload}/manager.env ${configRoot}/manager.env\ninstall -m 644 ${upload}/${caName} ${caPath}\ninstall -m 644 ${upload}/runtime.service /etc/systemd/system/agentonic-staging@.service\ninstall -m 644 ${upload}/controller.service /etc/systemd/system/agentonic-deployer-staging.service\nsystemctl daemon-reload\nrm -rf ${upload}\n`
    )
    assert.equal(
      ssh(`sha256sum ${release}/broker.mjs | cut -d' ' -f1`),
      packaged.brokerHash
    )
  } else {
    mkdirSync(serviceRoot, { recursive: true, mode: 0o700 })
    mkdirSync(instanceRoot, { recursive: true, mode: 0o700 })
    writeLocal(join(configRoot, "broker.env"), broker)
    writeLocal(join(configRoot, "manager.env"), manager)
  }
  await db.query(
    `INSERT INTO agentonic.runtime_hosts(environment,database_role,broker_sha256,runtime_sha256,verified_at) VALUES($1,$2,$3,$4,clock_timestamp())
 ON CONFLICT(environment) DO UPDATE SET broker_sha256=excluded.broker_sha256,runtime_sha256=excluded.runtime_sha256,verified_at=excluded.verified_at,revoked_at=NULL`,
    [
      azure ? "azure_staging" : "local",
      azure ? "agentonic_deployer_azure" : "agentonic_deployer_local",
      packaged.brokerHash,
      runtimeHash,
    ]
  )
  if (azure)
    ssh(
      "systemctl enable --now agentonic-deployer-staging.service\nsystemctl restart agentonic-deployer-staging.service\nsystemctl is-active agentonic-deployer-staging.service\n"
    )
  else {
    writeFileSync(
      join(workspace, "local-installation.json"),
      JSON.stringify({ release, config: join(configRoot, "manager.env") }) +
        "\n",
      { mode: 0o600 }
    )
    if (process.argv.includes("--start")) {
      // Fail if an existing controller is live instead of creating competing processes.
      const pidFile = join(workspace, "manager.pid")
      let alive = false
      if (existsSync(pidFile)) {
        try {
          process.kill(Number(readFileSync(pidFile, "utf8")), 0)
          alive = true
        } catch {
          /* A stale PID file does not indicate a running controller. */
        }
      }
      assert.ok(!alive, "Local staging controller already running")
      const child = spawn(
        process.execPath,
        [join(release, "broker.mjs"), "--manager"],
        {
          env: {
            PATH: process.env.PATH,
            AGENTONIC_STAGING_CONFIG: join(configRoot, "manager.env"),
          },
          detached: true,
          stdio: "ignore",
        }
      )
      child.unref()
      writeFileSync(pidFile, String(child.pid), { mode: 0o600 })
    }
  }
  console.log(
    JSON.stringify({
      installed: true,
      environment: azure ? "azure_staging" : "local",
      brokerHash: packaged.brokerHash,
      runtimeHash,
    })
  )
} catch (error) {
  fail(error)
} finally {
  await db?.end()
}
