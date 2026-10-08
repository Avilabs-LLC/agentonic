import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { root, loadLocal, connect, bootstrapConfig } from "./local-config.mjs"
// Explicit isolated staging deployment. No web apps, customer instances, ports,
// ingestion service, production environments or provider allowances are modified.
assert.ok(process.argv.includes("--deploy"), "Explicit --deploy required")
const host = "vm-agents-01"
assert.equal(bootstrapConfig().ref, "jkgdxkacariasunhentd")
const dbEnv = loadLocal(".env.database.local")
const db = await connect(
  dbEnv.AGENTONIC_MIGRATION_DATABASE_URL,
  dbEnv.AGENTONIC_DATABASE_CA_FILE
)
try {
  const active = await db.query(
    "SELECT (SELECT count(*) FROM agentonic.evaluation_runs WHERE status IN ('queued','running'))+(SELECT count(*) FROM agentonic.evaluation_preparations WHERE status IN ('queued','preparing')) n"
  )
  assert.equal(
    Number(active.rows[0].n),
    0,
    "Finish active evaluations before replacing the evaluator"
  )
} finally {
  await db.end()
}
const hash = (value) => createHash("sha256").update(value).digest("hex")
const ssh = (script) =>
  execFileSync("ssh", [host, "bash -se"], {
    input: script,
    stdio: ["pipe", "pipe", "pipe"],
  })
    .toString()
    .trim()
const packaged = JSON.parse(
  execFileSync(
    process.execPath,
    [join(root, "scripts/package-evaluation.mjs")],
    { cwd: root }
  ).toString()
)
assert.match(packaged.workerHash, /^[a-f0-9]{64}$/)
const runtimeSha = process.argv
  .find((value) => value.startsWith("--runtime-sha256="))
  ?.split("=")[1]
assert.match(
  runtimeSha ?? "",
  /^[a-f0-9]{64}$/,
  "Supply the registered frozen runtime artifact hash; do not rebuild an existing candidate"
)
const runtime = {
  artifactSha256: runtimeSha,
  directory: join(root, ".local/runtime", runtimeSha),
}
assert.equal(
  hash(readFileSync(join(runtime.directory, "manifest.json"))),
  runtimeSha
)
const runtimeManifest = JSON.parse(
  readFileSync(join(runtime.directory, "manifest.json"))
)
const release = `/opt/agentonic/evaluation/releases/${packaged.workerHash}`
const runtimeRoot = "/opt/agentonic/runtime/artifacts"
const nodeVersion = "v22.23.2",
  nodeSha = "d60acfe00a2932254bb0ad20e01b0d74397a0875595de719654b214f4b03f307"
const nodeRoot = `/opt/agentonic/node/${nodeVersion}`
const staging = join(root, ".local/evaluation/staging")
mkdirSync(staging, { recursive: true, mode: 0o700 })
const env = loadLocal(".env.evaluation.local"),
  keys = loadLocal("apps/worker/.env.local")
const url = new URL(env.AGENTONIC_EVAL_AZURE_DATABASE_URL)
assert.equal(
  decodeURIComponent(url.username),
  "agentonic_eval_azure.jkgdxkacariasunhentd"
)
const variables = {
  DATABASE_URL: url.toString(),
  AGENTONIC_DATABASE_CA_FILE: "/etc/agentonic/evaluation-staging/ca.pem",
  AGENTONIC_RUNTIME_ROOT: runtimeRoot,
  AGENTONIC_EVALUATION_WORKER_SHA256: packaged.workerHash,
  OPENAI_API_KEY: keys.OPENAI_API_KEY,
  VOYAGE_API_KEY: keys.VOYAGE_API_KEY,
  AGENTONIC_RERANK_ENABLED:
    keys.AGENTONIC_RERANK_ENABLED === "true" ? "true" : "false",
  NODE_ENV: "production",
}
assert.ok(variables.OPENAI_API_KEY && variables.VOYAGE_API_KEY)
writeFileSync(
  join(staging, "worker.env"),
  Object.entries(variables)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join("\n") + "\n",
  { mode: 0o600 }
)
writeFileSync(
  join(staging, "ca.pem"),
  readFileSync(env.AGENTONIC_DATABASE_CA_FILE),
  { mode: 0o600 }
)
// The evaluator waits out refusals and outages itself and exits only for configuration
// problems, so five failed starts in ten minutes leave the unit visibly failed.
const unit = `[Unit]
Description=Agentonic isolated staging evaluator
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5
[Service]
Type=simple
User=agentonic-eval
Group=agentonic-eval
WorkingDirectory=/var/lib/agentonic-evaluation-staging
EnvironmentFile=/etc/agentonic/evaluation-staging/worker.env
Environment=PATH=${nodeRoot}/bin:/usr/bin:/bin
ExecStart=${nodeRoot}/bin/node ${release}/worker.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
KillMode=control-group
StateDirectory=agentonic-evaluation-staging
StateDirectoryMode=0700
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectProc=invisible
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=169.254.169.254
SystemCallArchitectures=native
SystemCallFilter=@system-service
MemoryMax=768M
TasksMax=32
LimitCORE=0
StandardOutput=journal
StandardError=journal
LogRateLimitIntervalSec=30s
LogRateLimitBurst=30
[Install]
WantedBy=multi-user.target
`
writeFileSync(join(staging, "agentonic-evaluator-staging.service"), unit)
// Refuse to overwrite any existing installation: follow-up releases require review.
ssh(
  `test "$(hostname)" = vm-agents-01\n${process.argv.includes("--replace") ? "test -e" : "test ! -e"} /etc/systemd/system/agentonic-evaluator-staging.service\nsudo -n true\n`
)
const upload = ssh("mktemp -d /tmp/agentonic-evaluation.XXXXXXXX\n")
assert.match(upload, /^\/tmp\/agentonic-evaluation\.[A-Za-z0-9]+$/)
try {
  execFileSync(
    "scp",
    [
      "-q",
      "-r",
      packaged.directory,
      runtime.directory,
      staging,
      `${host}:${upload}/`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  ssh(`curl -fsSL https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-linux-x64.tar.xz -o ${upload}/node.tar.xz
printf '%s  %s\\n' '${nodeSha}' '${upload}/node.tar.xz' | sha256sum --check --status
sudo install -d -m 0755 /opt/agentonic/node
if test ! -d ${nodeRoot}; then
sudo mkdir ${nodeRoot}
sudo tar -xJf ${upload}/node.tar.xz --strip-components=1 -C ${nodeRoot}
fi
sudo chown -R root:root ${nodeRoot}
getent passwd agentonic-eval >/dev/null || sudo useradd --system --user-group --home-dir /var/lib/agentonic-evaluation-staging --shell /usr/sbin/nologin agentonic-eval
sudo install -d -m 0755 /opt/agentonic/evaluation/releases ${runtimeRoot}
if test ! -d ${release}; then
sudo cp -R ${upload}/${packaged.workerHash} ${release}
else
printf '%s  %s\\n' '${packaged.workerHash}' '${release}/worker.mjs' | sha256sum --check --status
fi
if test ! -d ${runtimeRoot}/${runtime.artifactSha256}; then sudo cp -R ${upload}/${runtime.artifactSha256} ${runtimeRoot}/${runtime.artifactSha256}; fi
sudo chown -R root:root ${release} ${runtimeRoot}/${runtime.artifactSha256}
sudo find ${release} ${runtimeRoot}/${runtime.artifactSha256} -type d -exec chmod 0555 {} +
sudo find ${release} ${runtimeRoot}/${runtime.artifactSha256} -type f -exec chmod 0444 {} +
sudo install -d -m 0700 /etc/agentonic/evaluation-staging
sudo install -m 0600 ${upload}/staging/worker.env /etc/agentonic/evaluation-staging/worker.env
sudo install -m 0644 ${upload}/staging/ca.pem ${release}/ca.pem
# The CA is public material; put it outside the root-only secret directory.
sudo sed -i 's@AGENTONIC_DATABASE_CA_FILE=.*@AGENTONIC_DATABASE_CA_FILE="${release}/ca.pem"@' /etc/agentonic/evaluation-staging/worker.env
sudo install -m 0644 ${upload}/staging/agentonic-evaluator-staging.service /etc/systemd/system/agentonic-evaluator-staging.service
sudo systemd-analyze verify /etc/systemd/system/agentonic-evaluator-staging.service
sudo systemctl daemon-reload
sudo systemctl enable --now agentonic-evaluator-staging.service
`)
  const measured = ssh(`systemctl is-active agentonic-evaluator-staging.service
sha256sum ${release}/worker.mjs ${runtimeRoot}/${runtime.artifactSha256}/manifest.json
sudo -u agentonic-eval test ! -w ${release}/worker.mjs
sudo -u agentonic-eval test ! -r /etc/agentonic/evaluation-staging/worker.env
old_pid=$(systemctl show -p MainPID --value agentonic-evaluator-staging.service)
sudo systemctl restart agentonic-evaluator-staging.service
new_pid=$(systemctl show -p MainPID --value agentonic-evaluator-staging.service)
test "$old_pid" != "$new_pid"
test "$new_pid" -gt 0
systemctl is-active agentonic-evaluator-staging.service
`)
  assert.ok(
    measured.includes(packaged.workerHash) &&
      measured.includes(runtime.artifactSha256)
  )
  for (const [path, digest] of Object.entries(runtimeManifest.files)) {
    assert.ok(
      ["src/surfaces/preview.mjs", "prompts/platform.md"].includes(path)
    )
    assert.match(digest, /^[a-f0-9]{64}$/)
    assert.equal(
      ssh(`sha256sum ${runtimeRoot}/${runtime.artifactSha256}/${path}\n`).split(
        " "
      )[0],
      digest
    )
  }
  const attestation = {
    host,
    environment: "azure_staging",
    workerSha256: packaged.workerHash,
    runtimeSha256: runtime.artifactSha256,
    verifiedAt: new Date().toISOString(),
    verification: {
      reviewProtocol: 3,
      // Answers platform tool cases' Gmail and web calls from fixtures (architecture §51).
      toolFixtures: 1,
      // Grades with rubric 5 on GPT-5.4 mini and writes criteria as requests (§56).
      reviewRubric: 5,
      isolation: true,
      recovery: true,
      artifactIntegrity: true,
      nodeVersion,
      nodeArchiveSha256: nodeSha,
      unitSha256: hash(unit),
      checks: [
        "root-owned immutable bundles",
        "dedicated OS identity",
        "restricted DB credential",
        "root-only environment file",
        "no listening application port",
        "systemd restart changes process",
        "deterministic lease-loss fencing test",
      ],
    },
  }
  writeFileSync(
    join(staging, "attestation.json"),
    JSON.stringify(attestation, null, 2) + "\n",
    { mode: 0o600 }
  )
  console.log(
    JSON.stringify({
      installed: true,
      host,
      workerHash: packaged.workerHash,
      runtimeHash: runtime.artifactSha256,
      registrationPending: true,
    })
  )
} finally {
  ssh(`rm -rf -- ${upload}\n`)
}
