// Single source for the Azure staging systemd units. Installation writes these bytes;
// re-verification compares installed files against them.
export const stagingNode = "/opt/agentonic/node/v22.23.2/bin/node"
export const stagingReleases = "/opt/agentonic/staging/releases"
/**
 * The host gateway: one process per host holds the database connections and
 * the provider keys for every agent copy. Copies reach it through a socket only
 * members of this group can open; they hold no password or key themselves.
 */
export const gatewayGroup = "agentonic-gateway"
export const gatewaySocket = "/run/agentonic-gateway/gateway.sock"
export const gatewayUnit = "agentonic-gateway-staging"
/**
 * Brokers released before the gateway held the provider keys. Their copies
 * still call providers themselves until they move to a newer broker, so their
 * template keeps network access and the database CA.
 */
export const directProviderBrokers = new Set([
  "042e079548b6f283e3fb8640ace3f50b4a4b906e4e4bbaf6f595d138d66e98cc",
  "c87a65555612ed4b467ea37d9c5b8d4fbcfd763dcff51f3375f22f4e7e75c7d3",
  "2af812627203fafcb32a302563aa62c26d7a3330a52af55a4d2923ec735fbb99",
])
/**
 * Brokers whose copies receive their frozen release through a per-copy unit
 * drop-in in /etc/systemd/system, which only root can write. Their controller
 * runs as root and their templates keep their installed bytes. Later brokers'
 * controllers run as `controllerUser`: a copy's release reaches it as a
 * credential directory the controller owns, and polkit lets that user start,
 * stop and reset only agent copies (`controllerRules`). The worker keeps the
 * same list (staging-controller.ts DROP_IN_BROKERS); a test compares them.
 */
export const dropInBrokers = new Set([
  ...directProviderBrokers,
  "58d9a1f3366ef70450cc7acc1b696728d3f12dc13270e529cce387598107ffe4",
])
export const controllerUser = "agentonic-controller"
export const controllerRulesPath =
  "/etc/polkit-1/rules.d/50-agentonic-controller.rules"
/** The only unit operations the controller's user may perform, on agent copies only. */
export const controllerRules = `// Agentonic: the staging deployment controller may start, stop and reset
// agent copies, and nothing else. Installed by scripts/install-staging.mjs.
polkit.addRule(function (action, subject) {
  if (
    subject.user === "${controllerUser}" &&
    action.id === "org.freedesktop.systemd1.manage-units" &&
    /^agentonic-staging-[a-f0-9]{64}@[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.service$/.test(
      action.lookup("unit") || ""
    ) &&
    ["start", "stop", "reset-failed"].indexOf(action.lookup("verb")) >= 0
  )
    return polkit.Result.YES
})
`
/** Addresses the gateway never needs: private networks and the Azure host endpoints. */
const gatewayDenied =
  "10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 168.63.129.16 fc00::/7 fe80::/10"

/** One agent service template per broker release, so copies of several releases run side by side. */
export function agentTemplate(broker) {
  if (!/^[a-f0-9]{64}$/.test(broker)) throw new Error("Invalid broker hash")
  return `agentonic-staging-${broker}@.service`
}

export function stagingUnits({ broker, serviceRoot, caPath, configRoot }) {
  const node = stagingNode
  const release = `${stagingReleases}/${broker}`
  agentTemplate(broker)
  // A copy exits 0 when it rests, drains or its deployment ends. A failing copy restarts at
  // most three times; the controller then paces further attempts. The controller and the
  // gateway exit only for configuration problems, so five failed starts in ten minutes
  // leave them visibly failed. A copy reaches everything through the gateway's socket, so
  // it runs without any network; copies of older brokers keep theirs (see above).
  // Later brokers' copies read their frozen release from a credential directory
  // the controller writes; symlinks in it are ignored when systemd loads it.
  const releaseCredential = dropInBrokers.has(broker)
    ? ""
    : `LoadCredential=release:${serviceRoot}/${broker}/%i\n`
  const runtime = directProviderBrokers.has(broker)
    ? `[Unit]\nDescription=Agentonic private staging runtime %i (broker ${broker.slice(0, 12)})\nAfter=network-online.target\nStartLimitIntervalSec=120\nStartLimitBurst=3\n[Service]\nType=simple\nDynamicUser=yes\nSupplementaryGroups=${gatewayGroup}\nLoadCredential=config:${serviceRoot}/${broker}/%i.env\nLoadCredential=ca:${caPath}\nEnvironment=AGENTONIC_DATABASE_CA_FILE=%d/ca\nExecStart=${node} ${release}/broker.mjs\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=15\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nCapabilityBoundingSet=\nMemoryMax=512M\nCPUQuota=100%\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n`
    : `[Unit]\nDescription=Agentonic private staging runtime %i (broker ${broker.slice(0, 12)})\nAfter=${gatewayUnit}.socket\nStartLimitIntervalSec=120\nStartLimitBurst=3\n[Service]\nType=simple\nDynamicUser=yes\nSupplementaryGroups=${gatewayGroup}\nLoadCredential=config:${serviceRoot}/${broker}/%i.env\n${releaseCredential}ExecStart=${node} ${release}/broker.mjs\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=15\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nPrivateNetwork=yes\nIPAddressDeny=any\nRestrictAddressFamilies=AF_UNIX\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nCapabilityBoundingSet=\nMemoryMax=512M\nCPUQuota=100%\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n`
  return {
    runtime,
    // Drop-in brokers' controllers write unit drop-ins and need root. Later ones run as
    // their own user with their configuration as credentials, write only their own
    // directories, and manage agent copies through the polkit rule above.
    controller: dropInBrokers.has(broker)
      ? `[Unit]\nDescription=Agentonic staging deployment controller\nAfter=network-online.target\nStartLimitIntervalSec=600\nStartLimitBurst=5\n[Service]\nType=simple\nUser=root\nEnvironment=AGENTONIC_STAGING_CONFIG=${configRoot}/manager.env\nExecStart=${node} ${release}/broker.mjs --manager\nRestart=on-failure\nRestartSec=10\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nReadWritePaths=/opt/agentonic/instances ${serviceRoot} /etc/systemd/system\nMemoryMax=256M\nCPUQuota=50%\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`
      : `[Unit]\nDescription=Agentonic staging deployment controller\nAfter=network-online.target\nStartLimitIntervalSec=600\nStartLimitBurst=5\n[Service]\nType=simple\nUser=${controllerUser}\nGroup=${controllerUser}\nLoadCredential=config:${configRoot}/manager.env\nLoadCredential=broker:${configRoot}/broker.env\nLoadCredential=ca:${caPath}\nEnvironment=AGENTONIC_BROKER_CONFIG=%d/broker\nEnvironment=AGENTONIC_DATABASE_CA_FILE=%d/ca\nExecStart=${node} ${release}/broker.mjs --manager\nRestart=on-failure\nRestartSec=10\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nCapabilityBoundingSet=\nReadWritePaths=/opt/agentonic/instances ${serviceRoot}\nMemoryMax=256M\nCPUQuota=50%\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`,
    gatewaySocket: `[Unit]\nDescription=Agentonic staging gateway socket\n[Socket]\nListenStream=${gatewaySocket}\nSocketUser=root\nSocketGroup=${gatewayGroup}\nSocketMode=0660\nDirectoryMode=0755\n[Install]\nWantedBy=sockets.target\n`,
    gateway: `[Unit]\nDescription=Agentonic staging gateway: database and providers (broker ${broker.slice(0, 12)})\nRequires=${gatewayUnit}.socket\nAfter=network-online.target ${gatewayUnit}.socket\nStartLimitIntervalSec=600\nStartLimitBurst=5\n[Service]\nType=simple\nDynamicUser=yes\nLoadCredential=config:${configRoot}/gateway.env\nLoadCredential=ca:${caPath}\nEnvironment=AGENTONIC_DATABASE_CA_FILE=%d/ca\nExecStart=${node} ${release}/broker.mjs --gateway\nRestart=on-failure\nRestartSec=5\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nIPAddressDeny=${gatewayDenied}\nCapabilityBoundingSet=\nMemoryMax=512M\nCPUQuota=100%\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n[Install]\nWantedBy=multi-user.target\n`,
  }
}

/**
 * The planned restart window. Updates install themselves daily, but kernel and
 * library updates only take effect after a restart; without a window they wait
 * until Azure restarts the VM unannounced. The service restarts only when updates
 * are waiting, and a window missed while the VM was off is skipped, never run late.
 */
export const restartWindowCalendar = "Sun *-*-* 04:00:00 Atlantic/Canary"
export function restartWindowUnits() {
  return {
    timer: `[Unit]\nDescription=Agentonic planned restart window (Sundays 04:00 Canary time)\n[Timer]\nOnCalendar=${restartWindowCalendar}\nPersistent=false\n[Install]\nWantedBy=timers.target\n`,
    service: `[Unit]\nDescription=Restart vm-agents-01 when installed updates are waiting for it\nConditionPathExists=/var/run/reboot-required\n[Service]\nType=oneshot\nExecStart=/usr/bin/systemctl reboot\n`,
  }
}
