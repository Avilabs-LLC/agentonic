import { fileURLToPath } from "node:url"
import type { NextConfig } from "next"
const config: NextConfig = {
  // Releases carry a self-contained server traced from the repository root
  // (architecture §53); `next dev` ignores both settings.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../..", import.meta.url)),
  transpilePackages: [
    "@workspace/ui",
    "@agentonic/contracts",
    "@agentonic/server",
    "@agentonic/database",
  ],
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg", "pg"],
  poweredByHeader: false,
  // Server action arguments can contain passwords and private customer content.
  logging: { serverFunctions: false },
}
export default config
