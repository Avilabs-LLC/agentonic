// Compares the address allowed to SSH into vm-agents-01 with this Mac's current one.
//
//   pnpm vm:allow-ssh            show both (read-only)
//   pnpm vm:allow-ssh --apply    allow SSH from this Mac's address instead of the old one
import {
  allowSshFrom,
  allowsAddress,
  publicAddress,
  sshRuleSources,
} from "./vm-access.mjs"

const args = process.argv.slice(2)
if (args.some((arg) => arg !== "--apply")) {
  console.error("Usage: pnpm vm:allow-ssh [--apply]")
  process.exit(2)
}
const sources = sshRuleSources()
if (!sources) {
  console.error("Could not read the Azure SSH rule. Sign in with `az login`.")
  process.exit(1)
}
const address = await publicAddress()
if (!address) {
  console.error("Could not look up this Mac's public address.")
  process.exit(1)
}
console.log(`SSH allowed from: ${sources.join(", ") || "nobody"}`)
console.log(`This Mac:         ${address}`)
if (allowsAddress(sources, address))
  console.log("This Mac may SSH into vm-agents-01.")
else if (!args.includes("--apply")) {
  console.log(
    "This Mac may not SSH into vm-agents-01. Run `pnpm vm:allow-ssh --apply` to allow it instead."
  )
  process.exitCode = 1
} else {
  allowSshFrom(address)
  console.log(`SSH now allowed from ${address} (was ${sources.join(", ")}).`)
}
