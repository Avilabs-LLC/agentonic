import { hostedProblems, siteProblems } from "./hosted-check.mjs"
import { hostnames, siteHostname } from "./platform-units.mjs"
// pnpm hosted:check — every outside check of the hosted apps (architecture §53)
// and of the public site (§85).
const problems = [
  ...(await hostedProblems(hostnames, { full: true })),
  ...(await siteProblems(siteHostname, { full: true })),
]
if (problems.length) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"))
  process.exitCode = 1
} else
  console.log(
    `Both apps answer over HTTPS on ${Object.values(hostnames).join(" and ")}, and the public site on ${siteHostname}: redirects, headers, signed-out access and origin checks pass.`
  )
