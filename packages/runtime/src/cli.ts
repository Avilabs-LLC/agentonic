import { compose } from "./agent/prompt-loader"
// Reads one authoring configuration from stdin and prints only its digest.
let input = ""
try {
  for await (const chunk of process.stdin) {
    input += chunk
    if (Buffer.byteLength(input) > 400000) throw new Error("Too large")
  }
  const output = compose(JSON.parse(input))
  console.log(JSON.stringify({ valid: true, sha256: output.sha256 }))
} catch {
  console.error("Invalid authoring configuration.")
  process.exitCode = 1
}
