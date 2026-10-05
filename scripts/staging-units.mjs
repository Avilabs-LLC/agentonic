// Single source for the Azure staging systemd units. Installation writes these bytes;
// re-verification compares installed files against them.
export const stagingNode = "/opt/agentonic/node/v22.23.2/bin/node"

export function stagingUnits({ release, serviceRoot, caPath, configRoot }) {
  const node = stagingNode
  return {
    runtime: `[Unit]\nDescription=Agentonic private staging runtime %i\nAfter=network-online.target\nStartLimitIntervalSec=120\nStartLimitBurst=3\n[Service]\nType=simple\nDynamicUser=yes\nLoadCredential=config:${serviceRoot}/%i.env\nLoadCredential=ca:${caPath}\nEnvironment=AGENTONIC_DATABASE_CA_FILE=%d/ca\nExecStart=${node} ${release}/broker.mjs\nRestart=on-failure\nRestartSec=10\nTimeoutStopSec=15\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectKernelTunables=yes\nProtectKernelModules=yes\nProtectControlGroups=yes\nRestrictSUIDSGID=yes\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nCapabilityBoundingSet=\nMemoryMax=512M\nCPUQuota=100%\nUMask=0077\nStandardOutput=journal\nStandardError=journal\n`,
    controller: `[Unit]\nDescription=Agentonic staging deployment controller\nAfter=network-online.target\n[Service]\nType=simple\nUser=root\nEnvironment=AGENTONIC_STAGING_CONFIG=${configRoot}/manager.env\nExecStart=${node} ${release}/broker.mjs --manager\nRestart=on-failure\nRestartSec=10\nNoNewPrivileges=yes\nProtectSystem=strict\nProtectHome=yes\nPrivateTmp=yes\nReadWritePaths=/opt/agentonic/instances ${serviceRoot} /etc/systemd/system\nMemoryMax=256M\nCPUQuota=50%\nUMask=0077\n[Install]\nWantedBy=multi-user.target\n`,
  }
}
