// SSH to vm-agents-01 is open only to the owner's home address (Azure rule
// AllowSSHFromHome on vm-agents-01-nsg). Read with the owner's Azure CLI sign-in,
// like the VM backup check. When the home address changes, every script that reaches
// the VM times out at the connect.
import { execFileSync } from "node:child_process"

const RULE = [
  "-g",
  "rg-agents-prod",
  "--nsg-name",
  "vm-agents-01-nsg",
  "-n",
  "AllowSSHFromHome",
]
const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

/** Source addresses the SSH rule allows; null if Azure could not be read. */
export function sshRuleSources() {
  try {
    const rule = JSON.parse(
      execFileSync(
        "az",
        [
          "network",
          "nsg",
          "rule",
          "show",
          ...RULE,
          "--query",
          "{one:sourceAddressPrefix,many:sourceAddressPrefixes}",
          "--only-show-errors",
          "-o",
          "json",
        ],
        { stdio: ["ignore", "pipe", "ignore"], timeout: 120_000 }
      ).toString()
    )
    return [rule.one, ...(rule.many ?? [])].filter(Boolean)
  } catch {
    return null
  }
}

/** This Mac's public IPv4 address; null if the lookup fails. */
export async function publicAddress() {
  try {
    const response = await globalThis.fetch("https://api.ipify.org", {
      signal: globalThis.AbortSignal.timeout(10_000),
    })
    const address = (await response.text()).trim()
    return IPV4.test(address) ? address : null
  } catch {
    return null
  }
}

const toNumber = (address) =>
  address.split(".").reduce((n, part) => n * 256 + Number(part), 0)

/** Whether any source (an address, a CIDR range or a wildcard) covers `address`. */
export function allowsAddress(sources, address) {
  return sources.some((source) => {
    if (["*", "Any", "Internet"].includes(source)) return true
    const [base, bits = "32"] = source.split("/")
    if (!IPV4.test(base) || !/^\d{1,2}$/.test(bits) || Number(bits) > 32)
      return false
    const block = 2 ** (32 - Number(bits))
    return (
      Math.floor(toNumber(base) / block) ===
      Math.floor(toNumber(address) / block)
    )
  })
}

/** True when the SSH rule leaves out this Mac's address, false when it allows it, null if unknown. */
export async function firewallExcludesMac() {
  const sources = sshRuleSources()
  const address = sources && (await publicAddress())
  return address ? !allowsAddress(sources, address) : null
}

/** Points the SSH rule at one address. Run by the owner, never by the scheduled job. */
export function allowSshFrom(address) {
  if (!IPV4.test(address)) throw new Error("Not an IPv4 address")
  execFileSync(
    "az",
    [
      "network",
      "nsg",
      "rule",
      "update",
      ...RULE,
      "--source-address-prefixes",
      address,
      "--only-show-errors",
      "-o",
      "none",
    ],
    { stdio: ["ignore", "inherit", "inherit"], timeout: 120_000 }
  )
}
