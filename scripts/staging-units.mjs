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
  const runtime = directProviderBrokers.has(broker)
    ? `[Unit]\nDescription=Agentonic private staging runtime %i (broker ${broker.slice(0, 12)})\nAfter=network-online.target\nStartLimitIntervalSec=120\nStartLimitBurst=3\n[Service]\nType=simple\nDynamicUser=yes\nSupplementaryGroups=${gatewayGroup}\nLoadCredential=config:${serviceRoot}/${broker}/%i.env\nLoadCredential=ca:${caPath}\nEnvironment=AGENTONIC_DATABASE_CA_FILE=%d/ca\nExecStart=${node} ${release}/broker.mjs\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=15\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nCapabilityBoundingSet=\nMemoryMax=512M\nCPUQuota=100%\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n`
    : `[Unit]\nDescription=Agentonic private staging runtime %i (broker ${broker.slice(0, 12)})\nAfter=${gatewayUnit}.socket\nStartLimitIntervalSec=120\nStartLimitBurst=3\n[Service]\nType=simple\nDynamicUser=yes\nSupplementaryGroups=${gatewayGroup}\nLoadCredential=config:${serviceRoot}/${broker}/%i.env\nExecStart=${node} ${release}/broker.mjs\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=15\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nPrivateNetwork=yes\nIPAddressDeny=any\nRestrictAddressFamilies=AF_UNIX\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nCapabilityBoundingSet=\nMemoryMax=512M\nCPUQuota=100%\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n`
  return {
    runtime,
    controller: `[Unit]\nDescription=Agentonic staging deployment controller\nAfter=network-online.target\nStartLimitIntervalSec=600\nStartLimitBurst=5\n[Service]\nType=simple\nUser=root\nEnvironment=AGENTONIC_STAGING_CONFIG=${configRoot}/manager.env\nExecStart=${node} ${release}/broker.mjs --manager\nRestart=on-failure\nRestartSec=10\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nReadWritePaths=/opt/agentonic/instances ${serviceRoot} /etc/systemd/system\nMemoryMax=256M\nCPUQuota=50%\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`,
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
