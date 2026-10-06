import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { lookup } from "node:dns/promises"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { bootstrapConfig, connect, loadLocal, root } from "./local-config.mjs"
import { releaseId } from "./platform-tree.mjs"
import {
  caddyfile,
  caddyfilePath,
  hostnames,
  platformConfig,
  platformReleases,
  platformRoot,
  platformServices,
  platformUnits,
  ports,
  releasePath,
} from "./platform-units.mjs"
import { stagingNode } from "./staging-units.mjs"
// Installs a published platform release on vm-agents-01 (architecture §53):
// the Admin and customer apps, the knowledge worker and the TLS proxy.
//
//   pnpm platform:install --azure --release <tag>   install or upgrade
//   pnpm platform:install --azure --rollback        back to the previous release
//
// The release must come from the Release workflow on a commit on main. The VM
// checks every file against the manifest before anything moves; the database
// must already have every migration the release expects (run pnpm db:migrate
// first; migrations are never reversed by a rollback). Services move one at a
// time, each through a health gate; a failed gate puts that service and any
// already moved back on the release they ran before. Evaluator, controller,
// gateway, agent services and Corby are not touched.
const host = "vm-agents-01",
  publicIp = "158.158.16.6"
assert.ok(process.argv.includes("--azure"), "Explicit --azure required")
assert.equal(bootstrapConfig().ref, "jkgdxkacariasunhentd")
const rollback = process.argv.includes("--rollback")
const tag = process.argv
  .find((value) => value.startsWith("--release="))
  ?.split("=")[1]
assert.ok(rollback !== Boolean(tag), "Choose --release=<tag> or --rollback")
const sha = (value) => createHash("sha256").update(value).digest("hex")
const ssh = (script) =>
  execFileSync("ssh", [host, "bash -se"], {
    input: `set -euo pipefail\n${script}`,
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  })
    .toString()
    .trim()
// Writes a file on the VM as root without the shell reading its content.
const put = (path, content, mode = "0644") =>
  ssh(
    `tmp=$(mktemp)\necho ${Buffer.from(content).toString("base64")} | base64 -d > "$tmp"\nsudo install -m ${mode} "$tmp" ${path}\nrm -f "$tmp"\n`
  )
const state = `${platformRoot}/installed.json`
const installed = JSON.parse(
  ssh(`sudo cat ${state} 2>/dev/null || echo '{"history":[]}'\n`)
)

let target
if (rollback) {
  assert.ok(installed.current, "Nothing is installed")
  target = installed.history.find(
    (entry) => entry.release !== installed.current.release
  )
  assert.ok(target, "No earlier release to go back to")
  assert.equal(
    ssh(`test -d ${releasePath(target.release)} && echo present\n`),
    "present"
  )
} else {
  // 1. The published files, checked here first.
  assert.match(tag, /^platform-\d+\.\d+\.\d+-[a-f0-9]{12}$/)
  const local = join(root, ".local/platform/releases", tag)
  mkdirSync(local, { recursive: true, mode: 0o700 })
  const published = JSON.parse(
    execFileSync("gh", [
      "release",
      "view",
      tag,
      "--json",
      "author,targetCommitish,assets",
    ]).toString()
  )
  assert.equal(
    published.author.login,
    "github-actions[bot]",
    "Not published by the Release workflow"
  )
  for (const name of ["platform.tar.gz", "manifest.json", "release.json"])
    if (!existsSync(join(local, name)))
      execFileSync("gh", [
        "release",
        "download",
        tag,
        "--pattern",
        name,
        "--dir",
        local,
      ])
  const manifestBytes = readFileSync(join(local, "manifest.json"))
  const manifest = JSON.parse(manifestBytes)
  const summary = JSON.parse(readFileSync(join(local, "release.json")))
  const release = releaseId(manifestBytes)
  assert.equal(
    summary.releaseId,
    release,
    "The manifest is not the published one"
  )
  assert.equal(
    sha(readFileSync(join(local, "platform.tar.gz"))),
    summary.archiveSha256,
    "The archive changed"
  )
  assert.equal(manifest.target, "linux-x64", "Built for another system")
  assert.equal(published.targetCommitish, manifest.commit)
  execFileSync("git", ["fetch", "-q", "origin", "main"], { cwd: root })
  execFileSync(
    "git",
    ["merge-base", "--is-ancestor", manifest.commit, "origin/main"],
    { cwd: root }
  )
  // 2. The database is ready for it.
  const database = loadLocal(".env.database.local")
  const db = await connect(
    database.AGENTONIC_MIGRATION_DATABASE_URL,
    database.AGENTONIC_DATABASE_CA_FILE
  )
  try {
    const applied = new Set(
      (
        await db.query(
          "SELECT migration_name FROM agentonic._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL"
        )
      ).rows.map((row) => row.migration_name)
    )
    const missing = manifest.migrations.filter((name) => !applied.has(name))
    assert.deepEqual(
      missing,
      [],
      "Apply the release's migrations first (pnpm db:migrate)"
    )
  } finally {
    await db.end()
  }
  target = {
    release,
    tag,
    commit: manifest.commit,
    platform: manifest.platform,
  }
  // 3. On the VM: unpack beside the releases, check every file with this
  // repository's checker, then make it root-owned and read-only.
  ssh(`test "$(hostname)" = ${host}\nsudo -n true\ntest -x ${stagingNode}\n`)
  const upload = ssh("mktemp -d /tmp/agentonic-platform.XXXXXXXX\n")
  assert.match(upload, /^\/tmp\/agentonic-platform\.[A-Za-z0-9]+$/)
  try {
    execFileSync("scp", [
      "-q",
      join(local, "platform.tar.gz"),
      join(local, "manifest.json"),
      join(root, "scripts/platform-tree.mjs"),
      `${host}:${upload}/`,
    ])
    const destination = releasePath(release)
    const checked =
      ssh(`sudo install -d -m 0755 ${platformRoot} ${platformReleases}
if sudo test -d ${destination}; then
  echo present
else
  incoming=${platformReleases}/.incoming-${release}
  sudo rm -rf "$incoming"
  sudo install -d -m 0700 "$incoming"
  sudo tar -xzf ${upload}/platform.tar.gz -C "$incoming" --no-same-owner --no-same-permissions
  echo unpacked
fi
`)
    const tree =
      checked === "present"
        ? destination
        : `${platformReleases}/.incoming-${release}`
    const problems = ssh(`cd ${upload}
sudo ${stagingNode} --input-type=module -e '
import { readFileSync } from "node:fs"
import { treeProblems } from "${upload}/platform-tree.mjs"
const problems = treeProblems(process.argv[1], JSON.parse(readFileSync("${upload}/manifest.json")))
console.log(JSON.stringify(problems.slice(0, 20)))
' ${tree}
`)
    assert.deepEqual(
      JSON.parse(problems),
      [],
      `The release on the VM does not match its manifest`
    )
    if (checked !== "present")
      ssh(`incoming=${platformReleases}/.incoming-${release}
sudo chown -R -h root:root "$incoming"
sudo find "$incoming" -type d -exec chmod 0555 {} +
sudo find "$incoming" -type f -exec chmod 0444 {} +
sudo chmod 0555 "$incoming"
sudo mv "$incoming" ${destination}
`)
  } finally {
    ssh(`rm -rf -- ${upload}\n`)
  }
}

// 4. Configuration: only the names each service needs, from the owner's local
// files; the database CA is passed as a credential.
const admin = loadLocal("apps/admin/.env.local"),
  customer = loadLocal("apps/customer/.env.local"),
  worker = loadLocal("apps/worker/.env.local")
const callback = `https://${hostnames.customer}/api/connections/google/callback`
const pick = (source, names) =>
  Object.fromEntries(
    names
      .filter((name) => source[name] !== undefined)
      .map((name) => [name, source[name]])
  )
const gmailKeys = [
  "AGENTONIC_CONNECTION_KEY",
  "AGENTONIC_CONNECTION_STANDBY_KEYS",
]
const files = {
  "admin.env": pick(admin, [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "DATABASE_URL",
    "AGENTONIC_DATABASE_ROLE",
  ]),
  "customer.env": {
    ...pick(customer, [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "DATABASE_URL",
      "AGENTONIC_DATABASE_ROLE",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      ...gmailKeys,
    ]),
    GOOGLE_REDIRECT_URI: callback,
  },
  "worker.env": {
    ...pick(worker, [
      "DATABASE_URL",
      "SUPABASE_URL",
      "SUPABASE_PUBLISHABLE_KEY",
      "AGENTONIC_STORAGE_EMAIL",
      "AGENTONIC_STORAGE_PASSWORD",
      "OPENAI_API_KEY",
      "VOYAGE_API_KEY",
      "BROWSERBASE_API_KEY",
      "AGENTONIC_RERANK_ENABLED",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      ...gmailKeys,
    ]),
    GOOGLE_REDIRECT_URI: callback,
  },
}
assert.equal(files["admin.env"].AGENTONIC_DATABASE_ROLE, "agentonic_admin")
assert.equal(
  files["customer.env"].AGENTONIC_DATABASE_ROLE,
  "agentonic_customer"
)
assert.match(
  decodeURIComponent(new URL(files["worker.env"].DATABASE_URL).username),
  /^agentonic_worker\./
)
for (const values of Object.values(files))
  assert.ok(!("SUPABASE_SECRET_KEY" in values))
const staging = join(root, ".local/platform/config")
mkdirSync(staging, { recursive: true, mode: 0o700 })
for (const [name, values] of Object.entries(files))
  writeFileSync(
    join(staging, name),
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600 }
  )
writeFileSync(
  join(staging, "ca.pem"),
  readFileSync(worker.AGENTONIC_DATABASE_CA_FILE),
  { mode: 0o600 }
)
const units = platformUnits(target.release)
for (const [name, unit] of Object.entries(units))
  writeFileSync(join(staging, `${platformServices[name]}.service`), unit, {
    mode: 0o600,
  })
const upload = ssh("mktemp -d /tmp/agentonic-platform-config.XXXXXXXX\n")
assert.match(upload, /^\/tmp\/agentonic-platform-config\.[A-Za-z0-9]+$/)
const moved = []
try {
  execFileSync("scp", ["-q", "-r", staging, `${host}:${upload}/`])
  ssh(`sudo install -d -m 0700 ${platformConfig}
for f in admin.env customer.env worker.env ca.pem; do sudo install -m 0600 ${upload}/config/$f ${platformConfig}/$f; done
`)
  // 5. One service at a time, each through its health gate.
  for (const name of ["worker", "customer", "admin"]) {
    const unit = `${platformServices[name]}.service`,
      path = `/etc/systemd/system/${unit}`
    const previous = ssh(`sudo cat ${path} 2>/dev/null || true\n`)
    if (
      previous === units[name].trim() &&
      ssh(`systemctl is-active ${unit} || true\n`) === "active"
    ) {
      console.log(JSON.stringify({ service: unit, unchanged: true }))
      continue
    }
    moved.push({ name, unit, path, previous })
    ssh(`sudo install -m 0644 ${upload}/config/${unit} ${path}
sudo systemd-analyze verify ${path}
sudo systemctl daemon-reload
sudo systemctl enable ${unit} >/dev/null 2>&1
sudo systemctl reset-failed ${unit} 2>/dev/null || true
sudo systemctl restart ${unit}
`)
    const gate = health(name)
    console.log(
      JSON.stringify({
        service: unit,
        release: target.release.slice(0, 12),
        ...gate,
      })
    )
    if (!gate.healthy) throw new Error(`${unit} failed its health gate`)
  }
} catch (error) {
  // Put every moved service back on what it ran before, newest first.
  for (const { unit, path, previous } of moved.reverse())
    if (previous) {
      put(path, previous + "\n")
      ssh(`sudo systemctl daemon-reload\nsudo systemctl restart ${unit}\n`)
    } else
      ssh(
        `sudo systemctl disable --now ${unit} >/dev/null 2>&1 || true\nsudo rm -f ${path}\nsudo systemctl daemon-reload\n`
      )
  console.error(
    JSON.stringify({
      installed: false,
      release: target.release,
      restored: moved.map((m) => m.unit),
      reason: error.message,
    })
  )
  process.exit(1)
} finally {
  ssh(`rm -rf -- ${upload}\n`)
}

// 6. The proxy, once both names point at this VM; certificates come on first use.
const resolved = await Promise.all(
  Object.values(hostnames).map((name) =>
    lookup(name).then(
      (r) => r.address,
      () => null
    )
  )
)
let proxy = "waiting for DNS"
if (resolved.every((address) => address === publicIp)) {
  const config = caddyfile()
  const current = ssh(`sudo cat ${caddyfilePath} 2>/dev/null || true\n`)
  ssh(
    `command -v caddy >/dev/null || (sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q caddy >/dev/null)\n`
  )
  if (current !== config.trim()) {
    put(`${caddyfilePath}.agentonic`, config)
    ssh(`caddy validate --adapter caddyfile --config ${caddyfilePath}.agentonic >/dev/null 2>&1
sudo mv ${caddyfilePath}.agentonic ${caddyfilePath}
sudo systemctl enable caddy >/dev/null 2>&1
sudo systemctl restart caddy
`)
  }
  proxy =
    ssh(`sudo sha256sum ${caddyfilePath}\n`).split(" ")[0] === sha(config)
      ? "installed"
      : "differs"
}

// 7. Record what runs, newest first; the last three releases stay on disk.
const history = [
  { ...target, installedAt: new Date().toISOString() },
  ...installed.history.filter((entry) => entry.release !== target.release),
].slice(0, 3)
const record = JSON.stringify({ current: history[0], history }, null, 2)
put(state, record + "\n")
ssh(`keep="${history.map((entry) => entry.release).join(" ")}"
for d in ${platformReleases}/*; do
  id=$(basename "$d")
  case " $keep " in *" $id "*) ;; *) sudo rm -rf -- "$d" ;; esac
done
`)
console.log(
  JSON.stringify({
    installed: true,
    release: target.release,
    tag: target.tag,
    commit: target.commit,
    proxy,
    ports,
  })
)

function health(name) {
  const unit = `${platformServices[name]}.service`
  const release = releasePath(target.release)
  // Apps: the process runs this release, answers its health route, and renders
  // the login page for its own name. Worker: it started with its providers and
  // Storage account, and kept claiming work without a database failure.
  const script =
    name === "worker"
      ? `since=$(date +%s); sleep 15
pid=$(systemctl show -p MainPID --value ${unit})
printf 'active\\t%s\\n' "$(systemctl is-active ${unit} || true)"
printf 'restarts\\t%s\\n' "$(systemctl show -p NRestarts --value ${unit})"
if [ "\${pid:-0}" -gt 0 ]; then printf 'command\\t%s\\n' "$(tr '\\0' ' ' < /proc/$pid/cmdline)"; fi
printf 'started\\t%s\\n' "$(sudo journalctl -u ${unit} --since @$((since-20)) -o cat | grep -c '"knowledge_worker_started".*"providerConfigured":true,"storageConfigured":true' || true)"
printf 'unavailable\\t%s\\n' "$(sudo journalctl -u ${unit} --since @$((since-20)) -o cat | grep -c knowledge_worker_unavailable || true)"
`
      : `for i in $(seq 1 60); do curl -fsS -o /dev/null http://127.0.0.1:${ports[name]}/api/health && break; sleep 1; done
pid=$(systemctl show -p MainPID --value ${unit})
printf 'active\\t%s\\n' "$(systemctl is-active ${unit} || true)"
printf 'restarts\\t%s\\n' "$(systemctl show -p NRestarts --value ${unit})"
if [ "\${pid:-0}" -gt 0 ]; then printf 'command\\t%s\\n' "$(tr '\\0' ' ' < /proc/$pid/cmdline)"; fi
printf 'health\\t%s\\n' "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${ports[name]}/api/health)"
printf 'login\\t%s\\n' "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${hostnames[name]}' -H 'X-Forwarded-Proto: https' http://127.0.0.1:${ports[name]}/login)"
`
  const facts = Object.fromEntries(
    ssh(script)
      .split("\n")
      .map((line) => line.split("\t"))
  )
  const runsRelease = (facts.command ?? "").includes(release)
  const healthy =
    facts.active === "active" &&
    facts.restarts === "0" &&
    runsRelease &&
    (name === "worker"
      ? Number(facts.started) >= 1 && facts.unavailable === "0"
      : facts.health === "200" && facts.login === "200")
  return {
    healthy,
    active: facts.active,
    restarts: facts.restarts,
    runsRelease,
    ...(name === "worker"
      ? { started: facts.started, unavailable: facts.unavailable }
      : { health: facts.health, login: facts.login }),
  }
}
