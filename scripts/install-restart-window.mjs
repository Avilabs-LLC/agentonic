import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { restartWindowUnits } from "./staging-units.mjs"
// Installs (or with --remove, removes) the planned restart window on vm-agents-01:
// a timer that restarts the VM on Sundays at 04:00 Canary time, only when installed
// updates are waiting for a restart. Touches no Agentonic service, configuration or data.
const remove = process.argv.includes("--remove")
const ssh = (script) =>
  execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "vm-agents-01", "sudo", "-n", "bash", "-se"],
    { input: script, stdio: ["pipe", "pipe", "pipe"] }
  )
    .toString()
    .trim()
const units = restartWindowUnits()
const install = (name, text) =>
  `cat > /etc/systemd/system/${name}.tmp <<'UNIT'\n${text}UNIT\nchmod 644 /etc/systemd/system/${name}.tmp\nmv /etc/systemd/system/${name}.tmp /etc/systemd/system/${name}`
const output = ssh(
  [
    "set -eu",
    'test "$(hostname)" = vm-agents-01',
    ...(remove
      ? [
          "systemctl disable --now agentonic-restart-window.timer 2>/dev/null || true",
          "rm -f /etc/systemd/system/agentonic-restart-window.timer /etc/systemd/system/agentonic-restart-window.service",
          "systemctl daemon-reload",
          "echo removed",
        ]
      : [
          install("agentonic-restart-window.service", units.service),
          install("agentonic-restart-window.timer", units.timer),
          "systemd-analyze verify /etc/systemd/system/agentonic-restart-window.timer /etc/systemd/system/agentonic-restart-window.service",
          "systemctl daemon-reload",
          "systemctl enable --now agentonic-restart-window.timer >/dev/null 2>&1",
          "systemctl is-active agentonic-restart-window.timer",
          "systemctl show -p NextElapseUSecRealtime --value agentonic-restart-window.timer",
          "test -f /var/run/reboot-required && echo restart-pending || echo no-restart-pending",
        ]),
    "",
  ].join("\n")
)
if (remove) assert.match(output, /removed$/)
else {
  const [state, next, pending] = output.split("\n").slice(-3)
  assert.equal(state, "active")
  console.log(JSON.stringify({ installed: true, next, pending }))
}
