// Single source for the Azure staging systemd units. Installation writes these bytes;
// re-verification compares installed files against them.
export const stagingNode = "/opt/agentonic/node/v22.23.2/bin/node"
export const stagingReleases = "/opt/agentonic/staging/releases"

/** One agent service template per broker release, so copies of several releases run side by side. */
export function agentTemplate(broker) {
  if (!/^[a-f0-9]{64}$/.test(broker)) throw new Error("Invalid broker hash")
  return `agentonic-staging-${broker}@.service`
}

export function stagingUnits({ broker, serviceRoot, caPath, configRoot }) {
  const node = stagingNode
  const release = `${stagingReleases}/${broker}`
  agentTemplate(broker)
  // A copy exits 0 when it drains or its deployment ends. A failing copy restarts at most
  // three times; the controller then paces further attempts. The controller exits only for
  // configuration problems, so five failed starts in ten minutes leave it visibly failed.
  return {
    runtime: `[Unit]\nDescription=Agentonic private staging runtime %i (broker ${broker.slice(0, 12)})\nAfter=network-online.target\nStartLimitIntervalSec=120\nStartLimitBurst=3\n[Service]\nType=simple\nDynamicUser=yes\nLoadCredential=config:${serviceRoot}/${broker}/%i.env\nLoadCredential=ca:${caPath}\nEnvironment=AGENTONIC_DATABASE_CA_FILE=%d/ca\nExecStart=${node} ${release}/broker.mjs\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=15\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nCapabilityBoundingSet=\nMemoryMax=512M\nCPUQuota=100%\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n`,
    controller: `[Unit]\nDescription=Agentonic staging deployment controller\nAfter=network-online.target\nStartLimitIntervalSec=600\nStartLimitBurst=5\n[Service]\nType=simple\nUser=root\nEnvironment=AGENTONIC_STAGING_CONFIG=${configRoot}/manager.env\nExecStart=${node} ${release}/broker.mjs --manager\nRestart=on-failure\nRestartSec=10\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nReadWritePaths=/opt/agentonic/instances ${serviceRoot} /etc/systemd/system\nMemoryMax=256M\nCPUQuota=50%\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`,
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
