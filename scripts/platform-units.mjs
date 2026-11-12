// Single source for the hosted platform on vm-agents-01 (architecture §53): the
// Admin and customer apps, the knowledge worker and the TLS proxy in front of
// the apps. Installation writes these bytes; re-verification compares them.
import { stagingNode } from "./staging-units.mjs"

export const platformRoot = "/opt/agentonic/platform"
export const platformReleases = `${platformRoot}/releases`
export const platformConfig = "/etc/agentonic/platform"
export const runtimeArtifacts = "/opt/agentonic/runtime/artifacts"
export const caddyfilePath = "/etc/caddy/Caddyfile"
/**
 * Every read or change of the VM's service secrets (everything under
 * /etc/agentonic: the platform's, the staging gateway's and the evaluator's
 * environment files) is recorded by the Linux audit daemon (CASA 6.7.1, §87).
 * Search with: sudo ausearch -k agentonic-secrets
 */
export const secretsAuditPath = "/etc/audit/rules.d/agentonic-secrets.rules"
export const secretsAuditRules = "-w /etc/agentonic -p rwa -k agentonic-secrets\n"
/** Public names; each app answers only on its own, so their cookies never mix. */
export const hostnames = {
  customer: "app.agentonic.avilabs.tech",
  admin: "admin.agentonic.avilabs.tech",
}
/** The public site (architecture §85): the customer app answers it too. Same as packages/contracts/src/site.ts. */
export const siteHostname = "agentonic.avilabs.tech"
/** Private listeners behind the proxy; nothing else on the VM uses them. */
export const ports = { admin: 3100, customer: 3101 }
export const platformServices = {
  admin: "agentonic-admin-staging",
  customer: "agentonic-customer-staging",
  worker: "agentonic-knowledge-staging",
}
const labels = {
  admin: "Admin app",
  customer: "customer app",
  worker: "knowledge worker",
}

export function releasePath(release) {
  if (!/^[a-f0-9]{64}$/.test(release)) throw new Error("Invalid release id")
  return `${platformReleases}/${release}`
}

// Shared by all three: no privileges, a read-only system, no other users'
// files, and no instance metadata endpoint. Each service exits only for
// configuration problems, so five failed starts in ten minutes leave it
// visibly failed for the twice-daily check.
const hardening = `NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectProc=invisible
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes
CapabilityBoundingSet=
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
IPAddressDeny=169.254.169.254
SystemCallArchitectures=native
SystemCallFilter=@system-service
UMask=0077
LimitCORE=0
StandardOutput=journal
StandardError=journal
LogRateLimitIntervalSec=30s
LogRateLimitBurst=60`

/**
 * One unit per service, pinned to one release directory. An upgrade rewrites
 * the unit to the new directory; a rollback rewrites it back.
 */
export function platformUnits(release) {
  const root = releasePath(release)
  const short = release.slice(0, 12)
  const app = (name) => `[Unit]
Description=Agentonic ${labels[name]} (release ${short})
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5
[Service]
Type=simple
DynamicUser=yes
EnvironmentFile=${platformConfig}/${name}.env
LoadCredential=ca:${platformConfig}/ca.pem
Environment=AGENTONIC_DATABASE_CA_FILE=%d/ca
Environment=NODE_ENV=production
Environment=AGENTONIC_ENVIRONMENT=staging
Environment=AGENTONIC_PUBLIC_URL=https://${hostnames[name]}
Environment=NEXT_TELEMETRY_DISABLED=1
Environment=HOSTNAME=127.0.0.1
Environment=PORT=${ports[name]}
WorkingDirectory=${root}/${name}/apps/${name}
ExecStart=${stagingNode} ${root}/${name}/apps/${name}/server.js
# Next.js exits 143 when systemd stops it with SIGTERM: a clean stop.
SuccessExitStatus=143
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
${hardening}
MemoryMax=1G
TasksMax=64
[Install]
WantedBy=multi-user.target
`
  return {
    admin: app("admin"),
    customer: app("customer"),
    // The worker forks its PDF parser and preview runtimes as children with
    // bounded heaps; frozen runtimes are read from the shared artifact store.
    worker: `[Unit]
Description=Agentonic ${labels.worker} (release ${short})
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5
[Service]
Type=simple
DynamicUser=yes
EnvironmentFile=${platformConfig}/worker.env
LoadCredential=ca:${platformConfig}/ca.pem
Environment=AGENTONIC_DATABASE_CA_FILE=%d/ca
Environment=AGENTONIC_RUNTIME_ROOT=${runtimeArtifacts}
Environment=NODE_ENV=production
WorkingDirectory=${root}/worker
ExecStart=${stagingNode} ${root}/worker/worker.mjs
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
KillMode=control-group
${hardening}
MemoryMax=2G
TasksMax=128
[Install]
WantedBy=multi-user.target
`,
  }
}

/**
 * The TLS proxy: certificates from Let's Encrypt, plain HTTP redirected, and
 * each name passed only to its own app. The admin endpoint is off, so only
 * root can change the proxy (by restarting it).
 */
export function caddyfile({ site: withSite = true } = {}) {
  const site = (name, maxSize, host = hostnames[name], extra = "") => `${host} {
	encode zstd gzip
	request_body {
		max_size ${maxSize}
	}
	header -Server${extra}
	reverse_proxy 127.0.0.1:${ports[name]}
}
`
  // The public site's root and English root are its pages under /sitio; the
  // proxy maps them here, so the app never rewrites across origins (§85).
  const sitePages = `
	@root path /
	rewrite @root /sitio
	@en path /en
	rewrite @en /sitio/en`
  return `# Agentonic hosted apps. Installed by scripts/install-platform.mjs.
{
	admin off
}
${site("customer", "12MB")}
${site("admin", "2MB")}${withSite ? `\n${site("customer", "1MB", siteHostname, sitePages)}` : ""}`
}
